Pre-rendered static tiles with Docker (node-mapnik + MBTiles)
=============================================================

A self-contained pipeline that compiles the style, pre-renders raster tiles for
an area/zoom range, and serves them — all via `docker compose`. It reuses the
project's existing `kosmtik` image (which already ships a working Mapnik), so it
needs no system Mapnik or Tirex. For the classic Tirex-based recipe see
[STATIC_TILE_SERVER.md](STATIC_TILE_SERVER.md); for Podman/server deployment see
[DEPLOY_PODMAN.md](DEPLOY_PODMAN.md).

## Prerequisites

1. An imported PostGIS database — see [DOCKER.md](DOCKER.md) (`docker compose up
   import`). The render reads vector data from it.
2. Land-polygon shapefiles in `data/` (the style's low-zoom coastline). In the
   dev workflow `kosmtik` fetches these automatically; on a fresh checkout run:
   ```sh
   sh scripts/get-land-polygons.sh
   ```

## Render and serve

```sh
# Render (default: the extent of the imported data, z0-10, to an MBTiles file):
docker compose --profile static run --rm render

# Serve it (mbtileserver, with a built-in Leaflet preview) on :18889:
docker compose --profile static up -d tileserver
```

- Preview:  `http://localhost:18889/services/cyclosm/map`
- XYZ:      `http://localhost:18889/services/cyclosm/tiles/{z}/{x}/{y}.png`
- TileJSON: `http://localhost:18889/services/cyclosm`

Re-running `render` hot-reloads the server (it watches the file).

## Options (env on the `render` service; override with `-e`)

| Variable | Default | Meaning |
|---|---|---|
| `BBOX` | `auto` | `auto` = extent of imported data; or `"W,S,E,N"` lon/lat |
| `MIN_ZOOM` / `MAX_ZOOM` | `0` / `10` | zoom range (inclusive) |
| `CLIP` | *(empty)* | OSM admin boundary name (`name`/`name:en`) to clip to; empty = render `BBOX`. Clipping skips sea/no-data tiles |
| `CLIP_ADMIN_LEVEL` | `2` | admin level of `CLIP` (2 = country, 4 = state/region) |
| `OUTPUT` | `mbtiles` | `mbtiles` (one file) or `dir` (loose `{z}/{x}/{y}.png`) |
| `MBTILES` / `TILE_DIR` | `mbtiles/cyclosm.mbtiles` / `tiles` | output location |
| `CONCURRENCY` | `4` | parallel renders (the entrypoint sets `UV_THREADPOOL_SIZE` to match); raise toward the core count |
| `SKIP_EXPORT` | `0` | `mapnik.xml` is cached + reused automatically (recompiled when the style changes); `1` forces reuse even when sources changed |

Examples:

```sh
# Clip to a country at higher zoom (much smaller than the bounding rectangle):
docker compose --profile static run --rm -e CLIP=France -e MAX_ZOOM=12 render

# Explicit bounding box, loose PNG output:
docker compose --profile static run --rm \
  -e BBOX=2.0,48.6,2.7,49.0 -e MAX_ZOOM=15 -e OUTPUT=dir render
```

## Tuning concurrency

Rendering is CPU-bound, but two limits decide the sweet spot:

- **libuv thread pool.** node-mapnik renders on libuv's thread pool, whose
  default size is **4**. The render entrypoint sets `UV_THREADPOOL_SIZE` to equal
  `CONCURRENCY` so raising `CONCURRENCY` actually adds parallelism — without that,
  `CONCURRENCY > 4` does nothing (or is slightly slower).
- **RAM, not cores, is usually the ceiling.** Each worker loads the style + the
  land-polygon index + a DB connection (~0.7-1 GB). Too many workers OOM the host.

To find the optimum on your hardware, sweep a fixed sample and watch tiles/s and
memory (`docker stats` / `podman stats`); pick the plateau before RAM runs out:

```sh
for c in 4 8 12; do
  rm -rf /tmp/bench
  docker compose --profile static run --rm \
    -e SKIP_EXPORT=1 -e OUTPUT=dir -e TILE_DIR=/tmp/bench \
    -e BBOX=20.85,52.05,21.25,52.45 -e MIN_ZOOM=14 -e MAX_ZOOM=14 \
    -e CONCURRENCY=$c render
done
```

When the DB shares the box, leave a couple of cores for PostgreSQL. As a starting
point use `CONCURRENCY ≈ min(cores, usable_RAM_GB)`. (Measured on a 12-core / 8 GB
host with the DB co-resident: throughput peaked at `CONCURRENCY=8`; `12` OOM'd.)

## Sizing

Tile count (and time and storage) roughly **quadruples per zoom level**. The full
extent of a large import past ~z12 is millions of tiles — clip to the area you
actually need, and prefer `OUTPUT=mbtiles` (one file) over millions of PNGs.
