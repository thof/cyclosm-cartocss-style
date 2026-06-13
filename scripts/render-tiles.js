#!/usr/bin/env node
/**
 * Batch-render static raster tiles from a compiled Mapnik XML using node-mapnik.
 *
 * Runs inside the kosmtik:v1 Docker image (see the `render` service in
 * docker-compose.yml), which provides the prebuilt `@mapnik/mapnik` core.
 * Build the XML first, e.g.:
 *   kosmtik export project.mml --localconfig docker/static/localconfig.json --output /tmp/mapnik.xml
 *
 * Tile set (what to render):
 *   TILE_LIST    path to a "z x y" file (one tile per line) — e.g. a clip cover.
 *                When set, BBOX/MIN_ZOOM/MAX_ZOOM are ignored.
 *   BBOX         "W,S,E,N" lon/lat (default whole world; the render-entrypoint
 *                normally resolves "auto" to the imported data extent and passes
 *                a concrete box here)
 *   MIN_ZOOM     inclusive                    (default 0)
 *   MAX_ZOOM     inclusive                    (default 10)
 *
 * Output (where to write):
 *   OUTPUT       "mbtiles" (default) | "dir"
 *   TILE_DIR     dir mode root for {z}/{x}/{y}.png   (default /cyclosm/tiles)
 *   MBTILES      mbtiles file path                   (default /cyclosm/mbtiles/cyclosm.mbtiles)
 *
 * Other:
 *   MAPNIK_XML   compiled XML        (default /cyclosm/docker/static/mapnik.xml)
 *   MAPNIK_BASE  base for rel paths  (default /cyclosm)
 *   CONCURRENCY  parallel renders    (default = CPU count)
 *
 * NOTE: mapnik.Projection.forward() is broken in this Mapnik 4.2 build, so we
 * compute Web-Mercator (EPSG:3857) meters directly rather than reprojecting.
 * MBTiles stores rows in the TMS scheme (y flipped): row = 2^z - 1 - y.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');
var mapnik = require('@mapnik/mapnik');

mapnik.register_default_input_plugins();
mapnik.registerFonts('/usr/share/fonts', { recurse: true });

var XML = process.env.MAPNIK_XML || '/cyclosm/docker/static/mapnik.xml';
var BASE = process.env.MAPNIK_BASE || '/cyclosm';
var OUTPUT = (process.env.OUTPUT || 'mbtiles').toLowerCase();
var TILE_DIR = process.env.TILE_DIR || '/cyclosm/tiles';
var MBTILES = process.env.MBTILES || '/cyclosm/mbtiles/cyclosm.mbtiles';
var TILE_LIST = process.env.TILE_LIST || '';
var MINZ = parseInt(process.env.MIN_ZOOM || '0', 10);
var MAXZ = parseInt(process.env.MAX_ZOOM || '10', 10);
var BBOX = (process.env.BBOX || '-180,-85.0511,180,85.0511').split(',').map(Number);
var CONC = parseInt(process.env.CONCURRENCY || String(os.cpus().length), 10);
var TILE = 256;

// --- Web Mercator (spherical, EPSG:3857) helpers ---
var R = 6378137, D2R = Math.PI / 180, MAX_LAT = 85.0511287798;
function clampLat(lat) { return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)); }
function lon2m(lon) { return lon * D2R * R; }
function lat2m(lat) { return R * Math.log(Math.tan(Math.PI / 4 + clampLat(lat) * D2R / 2)); }
function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tile(lat, z) {
  var r = clampLat(lat) * D2R;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
function tile2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function tile2lat(y, z) {
  var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// --- Build the job list (from a tile-list file, or the bbox/zoom range) ---
var jobs = [];
if (TILE_LIST) {
  var lines = fs.readFileSync(TILE_LIST, 'utf8').split('\n');
  for (var li = 0; li < lines.length; li++) {
    var p = lines[li].trim().split(/\s+/);
    if (p.length < 3 || p[0] === '') continue;
    jobs.push({ z: +p[0], x: +p[1], y: +p[2] });
  }
  console.log('[render] tile list ' + TILE_LIST + ': ' + jobs.length + ' tiles');
} else {
  for (var z = MINZ; z <= MAXZ; z++) {
    var nz = Math.pow(2, z);
    var xmin = Math.max(0, lon2tile(BBOX[0], z)), xmax = Math.min(nz - 1, lon2tile(BBOX[2], z));
    var ymin = Math.max(0, lat2tile(BBOX[3], z)), ymax = Math.min(nz - 1, lat2tile(BBOX[1], z));
    for (var x = xmin; x <= xmax; x++)
      for (var y = ymin; y <= ymax; y++)
        jobs.push({ z: z, x: x, y: y });
  }
  console.log('[render] bbox ' + BBOX.join(',') + ' zoom ' + MINZ + '-' + MAXZ + ': ' + jobs.length + ' tiles');
}

// Metadata zoom range + WGS84 bounds. Bounds are taken from the deepest zoom
// only, whose small tiles tightly hug the region (low-zoom tiles each span a
// huge area and would otherwise blow the bounds out to the whole world).
var zMin = 99, zMax = 0;
for (var jz = 0; jz < jobs.length; jz++) {
  if (jobs[jz].z < zMin) zMin = jobs[jz].z;
  if (jobs[jz].z > zMax) zMax = jobs[jz].z;
}
var bMinLon = 180, bMinLat = 90, bMaxLon = -180, bMaxLat = -90;
for (var j = 0; j < jobs.length; j++) {
  var t = jobs[j];
  if (t.z !== zMax) continue;
  bMinLon = Math.min(bMinLon, tile2lon(t.x, t.z));
  bMaxLon = Math.max(bMaxLon, tile2lon(t.x + 1, t.z));
  bMinLat = Math.min(bMinLat, tile2lat(t.y + 1, t.z));
  bMaxLat = Math.max(bMaxLat, tile2lat(t.y, t.z));
}

// --- Output sink: dir (loose PNGs) or mbtiles (single SQLite file) ---
function makeDirSink() {
  return {
    has: function (z, x, y) { return fs.existsSync(path.join(TILE_DIR, '' + z, '' + x, y + '.png')); },
    write: function (z, x, y, buf, cb) {
      var d = path.join(TILE_DIR, '' + z, '' + x);
      fs.mkdir(d, { recursive: true }, function () { fs.writeFile(path.join(d, y + '.png'), buf, cb); });
    },
    finalize: function (cb) { cb(); }
  };
}

function makeMbtilesSink() {
  fs.mkdirSync(path.dirname(MBTILES), { recursive: true });
  var seen = new Set();
  if (fs.existsSync(MBTILES)) {
    try {
      var rows = cp.execFileSync('sqlite3', [MBTILES,
        "SELECT zoom_level||'/'||tile_column||'/'||tile_row FROM tiles"],
        { maxBuffer: 1 << 30 }).toString();
      rows.split('\n').forEach(function (r) { if (r) seen.add(r); });
      if (seen.size) console.log('[render] mbtiles has ' + seen.size + ' existing tiles (will skip)');
    } catch (e) {
      var msg = String((e && e.stderr) || (e && e.message) || e);
      // A fresh file simply has no `tiles` table yet — nothing to resume.
      // Any other failure (e.g. output exceeds maxBuffer on a huge mbtiles) must
      // NOT be silent: warn so the operator knows resume is disabled this run.
      if (!/no such table/.test(msg)) {
        console.error('[render] WARNING: could not read existing tiles for resume (' +
          msg.trim() + '); all tiles will be re-rendered (writes use INSERT OR REPLACE).');
      }
    }
  }
  var proc = cp.spawn('sqlite3', [MBTILES]);
  var sqliteErr = null;
  proc.stderr.on('data', function (d) { process.stderr.write('[sqlite3] ' + d); });
  proc.on('error', function (e) { sqliteErr = sqliteErr || e; });
  proc.stdin.on('error', function (e) { sqliteErr = sqliteErr || e; });
  proc.on('exit', function (code) {
    if (code && !sqliteErr) sqliteErr = new Error('sqlite3 exited with code ' + code);
  });
  // journal_mode=DELETE (on-disk rollback journal) + synchronous=NORMAL: an
  // interrupted run rolls back the open transaction instead of corrupting the
  // file (unlike journal_mode=MEMORY + synchronous=OFF). DELETE (not WAL) keeps
  // the result a single plain file the tileserver can open from a read-only
  // mount — a WAL db needs write access to its -wal sidecar even to read.
  proc.stdin.write(
    'PRAGMA journal_mode=DELETE;PRAGMA synchronous=NORMAL;' +
    'CREATE TABLE IF NOT EXISTS metadata(name text,value text);' +
    'CREATE TABLE IF NOT EXISTS tiles(zoom_level int,tile_column int,tile_row int,tile_data blob);' +
    'CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles(zoom_level,tile_column,tile_row);' +
    'BEGIN;\n');
  var pending = 0;
  function tmsRow(z, y) { return Math.pow(2, z) - 1 - y; }
  return {
    has: function (z, x, y) { return seen.has(z + '/' + x + '/' + tmsRow(z, y)); },
    write: function (z, x, y, buf, cb) {
      if (sqliteErr) return cb(sqliteErr);
      var sql = "INSERT OR REPLACE INTO tiles VALUES(" + z + "," + x + "," + tmsRow(z, y) +
        ",x'" + buf.toString('hex') + "');\n";
      if (++pending % 500 === 0) proc.stdin.write('COMMIT;BEGIN;\n');
      if (proc.stdin.write(sql)) cb(); else proc.stdin.once('drain', cb);
    },
    finalize: function (cb) {
      var meta = {
        name: 'CyclOSM', type: 'baselayer', version: '1.0', format: 'png',
        description: 'CyclOSM static tiles',
        bounds: [bMinLon, bMinLat, bMaxLon, bMaxLat].map(function (n) { return n.toFixed(6); }).join(','),
        center: ((bMinLon + bMaxLon) / 2).toFixed(6) + ',' + ((bMinLat + bMaxLat) / 2).toFixed(6) + ',' +
          Math.round((zMin + zMax) / 2),
        minzoom: zMin, maxzoom: zMax
      };
      var m = 'COMMIT;\n';
      Object.keys(meta).forEach(function (k) {
        m += "INSERT OR REPLACE INTO metadata VALUES('" + k + "','" + String(meta[k]).replace(/'/g, "''") + "');\n";
      });
      m += '.quit\n';
      proc.on('close', function () { cb(sqliteErr); });
      proc.stdin.end(m);
    }
  };
}

var sink = OUTPUT === 'mbtiles' ? makeMbtilesSink() : makeDirSink();

// Resumable: drop tiles already present in the sink.
jobs = jobs.filter(function (t) { return !sink.has(t.z, t.x, t.y); });
var total = jobs.length;
console.log('[render] XML=' + XML + ' output=' + OUTPUT + ' concurrency=' + CONC);
console.log('[render] ' + total + ' tiles to render (already-present skipped)');
if (total === 0) {
  sink.finalize(function (err) {
    if (err) { console.error('[render] MBTiles write failed: ' + err.message); process.exit(3); }
    console.log('[render] nothing to do.'); process.exit(0);
  });
  return;
}

// --- Render one tile with a pre-loaded map object ---
function renderTile(map, job, done) {
  var z = job.z, x = job.x, y = job.y;
  map.zoomToBox([
    lon2m(tile2lon(x, z)), lat2m(tile2lat(y + 1, z)),
    lon2m(tile2lon(x + 1, z)), lat2m(tile2lat(y, z))
  ]);
  var im = new mapnik.Image(TILE, TILE);
  map.render(im, {}, function (err, im) {
    if (err) return done(err);
    sink.write(z, x, y, im.encodeSync('png'), done);
  });
}

// --- Worker pool: CONC map objects draining the job queue ---
var next = 0, done = 0, failed = 0, active = 0;
function dispatch(map) {
  if (next >= jobs.length) { if (--active === 0) finish(); return; }
  var job = jobs[next++];
  renderTile(map, job, function (err) {
    done++;
    if (err) { failed++; console.error('[render] FAILED ' + job.z + '/' + job.x + '/' + job.y + ': ' + err.message); }
    if (done % 200 === 0 || done === total) console.log('[render] ' + done + '/' + total + ' (' + failed + ' failed)');
    dispatch(map);
  });
}

var fatal = false;
// Flush the sink and exit; guarded so concurrent worker failures finalize once.
function abort(code, msg) {
  if (fatal) return;
  fatal = true;
  if (msg) console.error(msg);
  sink.finalize(function () { process.exit(code); });
}

function finish() {
  if (fatal) return;
  sink.finalize(function (err) {
    if (err) { console.error('[render] MBTiles write failed: ' + err.message); process.exit(3); }
    console.log('[render] done: ' + (total - failed) + ' rendered, ' + failed + ' failed' +
      (OUTPUT === 'mbtiles' ? ' -> ' + MBTILES : ' -> ' + TILE_DIR));
    process.exit(failed > 0 ? 1 : 0);
  });
}

var workers = Math.max(1, Math.min(CONC, jobs.length));
for (var i = 0; i < workers; i++) {
  active++;
  (function () {
    var map = new mapnik.Map(TILE, TILE);
    map.load(XML, { strict: false, base: BASE }, function (err, map) {
      if (err) { abort(2, '[render] failed to load ' + XML + ': ' + err.message); return; }
      map.bufferSize = 128;
      dispatch(map);
    });
  })();
}
