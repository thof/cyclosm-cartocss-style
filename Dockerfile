FROM debian:trixie-slim

# Style + kosmtik dependencies. git builds kosmtik from sources below.
# Mapnik itself comes from @mapnik/mapnik's prebuilt core package (pulled by
# npm), so no system Mapnik / build toolchain is required.
RUN apt-get update && apt-get install --no-install-recommends -y \
    ca-certificates curl git python3 postgresql-client sqlite3 nodejs npm \
    unzip fonts-hanazono fonts-noto-cjk fonts-noto-core fonts-noto-extra \
    fonts-unifont && rm -rf /var/lib/apt/lists/*

# @mapnik/mapnik ships a prebuilt core, but its preinstall script aborts under
# `set -e` when `mapnik-config -v` is missing (Mapnik 4 dropped mapnik-config).
# A tiny shim answering -v lets preinstall pass; the prebuilt core is then used
# as-is with no compilation.
RUN printf '#!/bin/sh\ncase "$1" in -v|--version) echo 4.2.2;; *) echo;; esac\n' \
    > /usr/local/bin/mapnik-config && chmod +x /usr/local/bin/mapnik-config

# Build kosmtik from sources (latest master)
# @mapnik/core hoisted as a sibling so node-gyp-build picks up the prebuilt
# binary instead of trying to compile; a wrapper exposes the kosmtik CLI.
RUN git clone --depth 1 https://github.com/kosmtik/kosmtik.git /opt/kosmtik \
    && (cd /opt/kosmtik && npm install) \
    && printf '#!/bin/sh\nexec node /opt/kosmtik/index.js "$@"\n' \
       > /usr/local/bin/kosmtik && chmod +x /usr/local/bin/kosmtik

WORKDIR /opt/kosmtik/
RUN kosmtik plugins --install kosmtik-overpass-layer \
                    --install kosmtik-fetch-remote \
                    --install kosmtik-overlay \
                    --install kosmtik-open-in-josm \
                    --install kosmtik-map-compare \
                    --install kosmtik-osm-data-overlay \
                    --install kosmtik-mapnik-reference \
                    --install kosmtik-geojson-overlay \
    && cp /root/.config/kosmtik.yml /tmp/.kosmtik-config.yml

# Closing section
RUN mkdir -p /cyclosm
WORKDIR /cyclosm

USER 1000
CMD sh scripts/docker-startup.sh kosmtik
