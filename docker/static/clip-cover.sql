-- Compute the slippy-tile cover of an administrative boundary by descending the
-- tile quadtree from z0 and keeping only tiles whose Web-Mercator envelope
-- intersects the (simplified, slightly buffered) boundary polygon.
--
-- psql variables:
--   :clipname  OSM boundary name; matched against the `name` or `name:en` tag
--              (e.g. Polska / Poland, Deutschland / Germany, France).
--   :level     admin_level of the boundary (2 = country, 4 = state/region, ...).
--   :minz :maxz  zoom range, inclusive.
-- Example:
--   psql -d osm -tA -F' ' -v minz=0 -v maxz=14 -v level=2 -v clipname=Polska \
--        -f docker/static/clip-cover.sql -o cover.txt
-- Output: one "z x y" (XYZ/Google scheme) line per tile, z in [minz, maxz].
WITH RECURSIVE clip AS (
  -- One-time: pick the boundary, simplify (cheaper intersection) and buffer
  -- outward ~1km so border tiles are never dropped (over-inclusion is harmless).
  SELECT ST_Buffer(ST_Simplify(way, 1000), 1000) AS geom
  FROM planet_osm_polygon
  WHERE boundary = 'administrative'
    AND admin_level = :'level'
    AND (name = :'clipname' OR tags->'name:en' = :'clipname')
  ORDER BY ST_Area(way) DESC
  LIMIT 1
),
q(z, x, y) AS (
  SELECT 0, 0, 0
  UNION ALL
  SELECT c.z + 1, c.x * 2 + dx, c.y * 2 + dy
  FROM q c
       CROSS JOIN clip
       CROSS JOIN (VALUES (0), (1)) AS gx(dx)
       CROSS JOIN (VALUES (0), (1)) AS gy(dy)
  WHERE c.z < :maxz
    AND ST_Intersects(clip.geom, ST_TileEnvelope(c.z + 1, c.x * 2 + dx, c.y * 2 + dy))
)
SELECT z, x, y FROM q WHERE z >= :minz;
