Deploying the CyclOSM tile stack with Podman (rootless, Fedora/RHEL/Oracle Linux, arm64)
========================================================================================

This runs the **full pipeline** — PostGIS + import + render + MBTiles server —
on a rootless Podman host, reusing `docker-compose.yml` plus the Podman overlay
`docker-compose.podman.yml`.

Everything is arm64-native (Debian base images, `imresamu/postgis`,
`ghcr.io/consbio/mbtileserver`, and `@mapnik/mapnik`'s prebuilt linux-arm64 core),
so nothing needs rebuilding for the architecture.

## 0. Prerequisites

```sh
sudo dnf install -y podman podman-compose git curl unzip
```

- **Rootless mapping**: ensure your user has subuid/subgid ranges (usually preset
  on Fedora; check `grep "$USER" /etc/subuid /etc/subgid`). If empty:
  `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"`
  then log out/in.
- **Registries**: Fedora's default `unqualified-search-registries` includes
  `docker.io`, so the unqualified image names (`debian`, `imresamu/postgis`)
  resolve. If yours doesn't, add `docker.io` to
  `/etc/containers/registries.conf` or fully-qualify the names.
- **SELinux**: the compose file uses `:z` bind-mount labels, which work whether
  SELinux is permissive or enforcing (and are no-ops when disabled).

`podman-compose` is used below; `podman compose` (the v2 provider) also works if
installed. Profiles require podman-compose ≥ 1.0.6.

A convenience alias for the rest of this doc:

```sh
alias dc='podman-compose -f docker-compose.yml -f docker-compose.podman.yml'
```

## 1. Get the code + data

```sh
git clone https://github.com/thof/cyclosm-cartocss-style.git
cd cyclosm-cartocss-style
curl -L -o data.osm.pbf https://download.geofabrik.de/europe/poland-latest.osm.pbf # the region to render
sh scripts/get-land-polygons.sh                                                    # land shapefiles -> data/
```

`get-land-polygons.sh` downloads the coastline/land shapefiles the style needs
into `data/land-low/` and `data/land-high/` (≈0.6 GB download, ≈1.3 GB extracted).

## 2. Build the local images

```sh
dc build            # builds kosmtik:v1 and import:v1 via buildah
```

## 3. Import the OSM data (one-time; repeat only when data.osm.pbf changes)

```sh
dc up -d db
dc run --rm import
```

Import tuning lives in `.env` (created on first import). For a big extract raise
`OSM2PGSQL_CACHE` / `OSM2PGSQL_NUMPROC` and `PG_MAINTENANCE_WORK_MEM` to match the
box, then re-run `dc run --rm import` (it re-imports from scratch — see DOCKER.md).
The DB persists in the `db-data` named volume; re-import only on data updates.

## 4. Render tiles to MBTiles

```sh
# Default: the extent of the imported data (BBOX=auto), z0-10:
dc --profile static run --rm render

# Or clip to a country/region boundary (skips sea/no-data), at higher zoom.
# CLIP is an OSM admin boundary name (name or name:en); CLIP_ADMIN_LEVEL=2 is a
# country (4 = state/region). Examples:
dc --profile static run --rm -e CLIP=Polska -e MAX_ZOOM=12 render
dc --profile static run --rm -e CLIP=France -e MAX_ZOOM=12 render
```

Output goes to `mbtiles/cyclosm.mbtiles`. Knobs (`CLIP`, `MAX_ZOOM`, `BBOX`,
`CONCURRENCY`, `OUTPUT`, `SKIP_EXPORT`, `SKIP_COVER`) are env vars on the `render`
service — override with `-e`. The first run compiles `mapnik.xml` (a few minutes,
CPU-bound) to `docker/static/mapnik.xml`; later runs reuse it automatically and
only recompile when `project.mml`/`*.mss`/`localconfig.json` change (`SKIP_EXPORT=1`
forces reuse regardless).

## 5. Serve

```sh
dc --profile static up -d tileserver
```

- Preview map:  `http://<host>:18889/services/cyclosm/map`
- XYZ tiles:    `http://<host>:18889/services/cyclosm/tiles/{z}/{x}/{y}.png`
- Service list: `http://<host>:18889/services`

The server has `--enable-fs-watch`, so re-rendering `mbtiles/cyclosm.mbtiles`
hot-reloads without a restart.

## Notes

- **Remote access**: ports bind to `127.0.0.1` by default. To expose the tile
  server on the network, change the `tileserver` port mapping to `18889:8080`
  (drop the `127.0.0.1:`) or, better, put a TLS reverse proxy (Caddy/nginx) in
  front of it. The DB/kosmtik ports should stay localhost-only.
- **Start on boot**: `podman-compose` doesn't manage boot. To keep the server
  running across reboots, either enable lingering (`loginctl enable-linger
  "$USER"`) and a user unit, or generate Quadlet units for the tileserver.
- **Bind-mount writes (rootless)**: `docker-compose.podman.yml` runs the
  `kosmtik`/`render` containers as `user: 0`, which maps to your host user under
  rootless Podman so they can write the bind-mounted repo. (`db` uses a named
  volume and `import` already runs as root, so neither needs it.) If PostGIS init
  ever complains about volume ownership, remove the volume
  (`dc down && podman volume rm cyclosm-cartocss-style_db-data`) and retry.
- **Serve-only alternative**: if the box only needs to serve, render the
  `.mbtiles` elsewhere, copy it into `mbtiles/` here, and run just step 5.
