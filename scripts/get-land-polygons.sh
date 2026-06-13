#!/bin/sh
# Fetch the OSM land-polygon shapefiles that the static-tile pipeline's
# localconfig (docker/static/localconfig.json) expects at:
#   data/land-low/land-low.shp    (zoom 0-9, simplified)
#   data/land-high/land-high.shp  (zoom 10+, full)
#
# On the dev machine these are normally fetched by kosmtik's fetch-remote plugin;
# on a fresh server run this once before rendering. Needs curl + unzip.
# Safe to re-run: files already present are skipped.
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

fetch() {
  name="$1"; url="$2"
  if [ -f "data/$name/$name.shp" ]; then
    echo "[land] $name already present — skipping"
    return
  fi
  echo "[land] downloading $name from $url ..."
  mkdir -p "data/$name"
  tmp="$(mktemp -d)"
  curl -fL -o "$tmp/d.zip" "$url"
  unzip -j -o "$tmp/d.zip" -d "$tmp" >/dev/null
  # Pick the extracted .shp without a masking pipeline (ls|head would hide a
  # zero-match glob, since the pipeline's exit status is head's, not ls's).
  set -- "$tmp"/*.shp
  if [ ! -f "$1" ]; then
    echo "[land] ERROR: no .shp found in $url archive" >&2
    rm -rf "$tmp"; exit 1
  fi
  base="$(basename "$1" .shp)"
  for ext in shp shx dbf prj cpg; do
    [ -f "$tmp/$base.$ext" ] && mv "$tmp/$base.$ext" "data/$name/$name.$ext"
  done
  rm -rf "$tmp"
  echo "[land] $name ready -> data/$name/$name.shp"
}

fetch land-low  "https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip"
fetch land-high "https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip"
echo "[land] done."
