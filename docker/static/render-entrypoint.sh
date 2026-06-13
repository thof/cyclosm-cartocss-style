#!/bin/sh
# Pipeline for the `render` service: compile project.mml -> mapnik.xml, then
# batch-render static tiles (to a directory or MBTiles), optionally clipped to an
# administrative boundary. Run from /cyclosm (working_dir in docker-compose).
#
# What gets rendered:
#   CLIP unset/empty/"none"  -> the BBOX rectangle.
#       BBOX="auto" (default) -> the extent of the imported data (queried from PostGIS).
#       BBOX="W,S,E,N"        -> that lon/lat rectangle.
#   CLIP="<name>"            -> only tiles intersecting the admin boundary whose
#       name (or name:en) is <name>, at admin_level CLIP_ADMIN_LEVEL (default 2).
set -e

export HOME=/tmp                       # kosmtik export wants a writable HOME
# Default to a path on the bind-mounted repo so the compiled XML survives across
# `run --rm` containers (an ephemeral /tmp would force a re-export every run).
MAPNIK_XML="${MAPNIK_XML:-/cyclosm/docker/static/mapnik.xml}"

# Compile unless a cached XML exists and is newer than the style sources.
# SKIP_EXPORT=1 forces reuse even if the sources changed.
need_export=1
if [ -f "$MAPNIK_XML" ]; then
  if [ "${SKIP_EXPORT:-0}" = "1" ]; then
    need_export=0
  elif [ -z "$(find project.mml *.mss docker/static/localconfig.json -newer "$MAPNIK_XML" 2>/dev/null)" ]; then
    need_export=0   # cached XML is up to date with project.mml / *.mss / localconfig
  fi
fi
if [ "$need_export" = "1" ]; then
  echo "[render] Compiling project.mml -> $MAPNIK_XML (this can take several minutes)..."
  mkdir -p "$(dirname "$MAPNIK_XML")"
  kosmtik export project.mml \
    --localconfig docker/static/localconfig.json \
    --output "$MAPNIK_XML"
else
  echo "[render] Reusing cached $MAPNIK_XML (up to date)"
fi
export MAPNIK_XML

# Preflight: the land-polygon shapefiles the localconfig points at must exist,
# else the render fails later with a cryptic Mapnik shapefile error.
for lp in land-low land-high; do
  if [ ! -f "data/$lp/$lp.shp" ]; then
    echo "[render] ERROR: missing data/$lp/$lp.shp — run 'sh scripts/get-land-polygons.sh' first." >&2
    exit 1
  fi
done

CLIP="${CLIP:-}"
if [ -n "$CLIP" ] && [ "$CLIP" != "none" ]; then
  # Clip to an administrative boundary: render only intersecting tiles.
  COVER="${TILE_LIST:-/tmp/cover.txt}"
  if [ "${SKIP_COVER:-0}" != "1" ] || [ ! -s "$COVER" ]; then
    echo "[render] Computing tile cover for '$CLIP' (admin_level ${CLIP_ADMIN_LEVEL:-2}) z${MIN_ZOOM:-0}-${MAX_ZOOM:-10} ..."
    # ON_ERROR_STOP=1 so a SQL error makes psql exit non-zero (caught by `set -e`)
    # instead of silently leaving a partial/empty cover.
    psql -d "${PGDATABASE:-osm}" -q -tA -F' ' -v ON_ERROR_STOP=1 \
      -v minz="${MIN_ZOOM:-0}" -v maxz="${MAX_ZOOM:-10}" \
      -v level="${CLIP_ADMIN_LEVEL:-2}" -v clipname="$CLIP" \
      -f docker/static/clip-cover.sql -o "$COVER"
    if [ ! -s "$COVER" ]; then
      echo "[render] ERROR: no boundary named '$CLIP' at admin_level ${CLIP_ADMIN_LEVEL:-2} in the database." >&2
      exit 1
    fi
    echo "[render] cover: $(wc -l < "$COVER") tiles"
  else
    echo "[render] Reusing existing cover $COVER (SKIP_COVER=1)"
  fi
  export TILE_LIST="$COVER"
else
  # No clip: render the BBOX rectangle. "auto" = extent of the imported data.
  if [ "${BBOX:-auto}" = "auto" ]; then
    BBOX="$(psql -d "${PGDATABASE:-osm}" -tA -v ON_ERROR_STOP=1 -c \
      "SELECT ST_XMin(g)||','||ST_YMin(g)||','||ST_XMax(g)||','||ST_YMax(g) \
       FROM (SELECT ST_Extent(ST_Transform(way,4326)) g FROM planet_osm_point) s;")"
    # Validate: four numeric fields and a non-degenerate box (W<E, S<N). An empty
    # DB yields NULL (blank), a single point yields a zero-area box — reject both.
    IFS=, read -r w s e n <<EOF
$BBOX
EOF
    if [ -z "$n" ] || ! awk -v w="$w" -v s="$s" -v e="$e" -v n="$n" \
         'BEGIN { exit (w+0 < e+0 && s+0 < n+0) ? 0 : 1 }'; then
      echo "[render] ERROR: could not determine a valid data extent (got '$BBOX'); is the DB imported?" >&2
      exit 1
    fi
    export BBOX
    echo "[render] auto BBOX (imported data extent) = $BBOX"
  fi
fi

# node-mapnik renders on libuv's thread pool, whose default size is 4 — so
# CONCURRENCY > 4 has no effect unless the pool is enlarged to match. Must be set
# before node starts. An explicit UV_THREADPOOL_SIZE wins; otherwise track CONCURRENCY.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-${CONCURRENCY:-4}}"

echo "[render] Rendering tiles (output=${OUTPUT:-mbtiles}, concurrency=${CONCURRENCY:-4}, UV_THREADPOOL_SIZE=$UV_THREADPOOL_SIZE)..."
exec node /cyclosm/scripts/render-tiles.js
