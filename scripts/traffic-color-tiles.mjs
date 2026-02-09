import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const TARGET = {
  lat: 48.8581,
  lon: 2.3727,
  zoom: 9.04,
};

const VIEWPORT = { width: 1280, height: 720 };
const TILE_SIZE = 512;
const TILE_ZOOM = Math.floor(TARGET.zoom);
const TILE_URL_TEMPLATE =
  'https://mf-maps-trafficolor-rc.dev-dcadcx.michelin.fr/trafficolor/{z}/{x}/{y}';

const COLOR_HEX_BY_VALUE = {
  1: '#000000',
  2: '#e60000',
  3: '#ffaa00',
};

const lonLatToPixel = (lon, lat, zoom, tileSize) => {
  const scale = 2 ** zoom;
  const x = ((lon + 180) / 360) * tileSize * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) *
    tileSize *
    scale;
  return { x, y };
};

const tileRangeForViewport = ({ lat, lon, zoom }, viewport, tileSize) => {
  const center = lonLatToPixel(lon, lat, zoom, tileSize);
  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;

  const minPixelX = center.x - halfWidth;
  const maxPixelX = center.x + halfWidth;
  const minPixelY = center.y - halfHeight;
  const maxPixelY = center.y + halfHeight;

  return {
    minX: Math.floor(minPixelX / tileSize),
    maxX: Math.floor(maxPixelX / tileSize),
    minY: Math.floor(minPixelY / tileSize),
    maxY: Math.floor(maxPixelY / tileSize),
  };
};

const formatTileUrl = (template, z, x, y) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

const readTileColors = async (z, x, y) => {
  const url = formatTileUrl(TILE_URL_TEMPLATE, z, x, y);
  const response = await fetch(url);
  if (!response.ok) {
    return { tileId: `${z}/${x}/${y}`, url, error: `${response.status} ${response.statusText}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const tile = new VectorTile(new Pbf(buffer));
  const counts = new Map();

  Object.keys(tile.layers).forEach((layerName) => {
    const layer = tile.layers[layerName];
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i);
      const value = feature?.properties?.color;
      if (value === undefined || value === null) continue;
      const key = String(value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });

  const colors = Array.from(counts.entries()).map(([value, count]) => ({
    value,
    hex: COLOR_HEX_BY_VALUE[value] ?? null,
    count,
  }));

  return {
    tileId: `${z}/${x}/${y}`,
    url,
    colors,
  };
};

const main = async () => {
  const range = tileRangeForViewport(TARGET, VIEWPORT, TILE_SIZE);
  const tiles = [];

  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      tiles.push({ x, y });
    }
  }

  const results = [];
  for (const tile of tiles) {
    const result = await readTileColors(TILE_ZOOM, tile.x, tile.y);
    if (result.error) {
      results.push(result);
      continue;
    }
    if (result.colors.length > 0) {
      results.push(result);
    }
  }

  const summary = {
    tileZoom: TILE_ZOOM,
    tileCount: tiles.length,
    endpoint: TILE_URL_TEMPLATE,
    tilesWithTrafficColors: results,
  };

  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error('Traffic color scan failed:', error);
  process.exitCode = 1;
});
