import { test, expect, Page } from '@playwright/test';

const TARGET_URL =
  'https://review-mf-tfc-dem-n01jvo-review.dev-dcadcx.michelin.fr/traffic-color/#9.04/48.8581/2.3727';

type TileColorSummary = {
  container: string;
  index: number;
  tileId: string;
  src: string | null;
  colors: string[];
  colorCounts: Record<string, number>;
  sampleCount: number;
  error?: string;
};

async function collectTrafficColors(
  page: Page,
  containers: string[],
): Promise<TileColorSummary[]> {
  return page.evaluate(({ containers }) => {
    const results: TileColorSummary[] = [];

    const trimSrc = (src: string | null) => {
      if (!src) return null;
      return src.length > 180 ? `${src.slice(0, 177)}...` : src;
    };

    const tileIdFromUrl = (src: string | null, fallback: string) => {
      if (!src) return fallback;
      try {
        const url = new URL(src, window.location.href);
        const pathMatch = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?$/);
        if (pathMatch) {
          return `${pathMatch[1]}/${pathMatch[2]}/${pathMatch[3]}`;
        }
        const z = url.searchParams.get('z');
        const x = url.searchParams.get('x');
        const y = url.searchParams.get('y');
        if (z && x && y) {
          return `${z}/${x}/${y}`;
        }
      } catch {
        return fallback;
      }
      return fallback;
    };

    const rgbToHsl = (r: number, g: number, b: number) => {
      const rNorm = r / 255;
      const gNorm = g / 255;
      const bNorm = b / 255;
      const max = Math.max(rNorm, gNorm, bNorm);
      const min = Math.min(rNorm, gNorm, bNorm);
      let h = 0;
      let s = 0;
      const l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case rNorm:
            h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0);
            break;
          case gNorm:
            h = (bNorm - rNorm) / d + 2;
            break;
          default:
            h = (rNorm - gNorm) / d + 4;
            break;
        }
        h *= 60;
      }
      return { h, s, l };
    };

    const bucketForHue = (h: number, l: number) => {
      if (h >= 75 && h <= 160) return 'green';
      if (h >= 45 && h < 75) return 'yellow';
      if (h >= 20 && h < 45) return 'orange';
      if (h < 20 || h >= 340) return l < 0.45 ? 'dark red' : 'red';
      return null;
    };

    const analyzePixelData = (data: Uint8ClampedArray, width: number, height: number) => {
      const counts: Record<string, number> = {
        green: 0,
        yellow: 0,
        orange: 0,
        red: 0,
        'dark red': 0,
      };
      const step = Math.max(1, Math.floor(Math.min(width, height) / 32));
      let usableSamples = 0;

      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const idx = (y * width + x) * 4;
          const alpha = data[idx + 3];
          if (alpha < 60) continue;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const { h, s, l } = rgbToHsl(r, g, b);
          if (s < 0.25 || l < 0.2 || l > 0.95) continue;
          const bucket = bucketForHue(h, l);
          if (!bucket) continue;
          counts[bucket] += 1;
          usableSamples += 1;
        }
      }

      const minCount = Math.max(5, Math.floor(usableSamples * 0.02));
      const colors = Object.entries(counts)
        .filter(([, count]) => count >= minCount)
        .map(([name]) => name);

      return { colors, counts, sampleCount: usableSamples };
    };

    const readElementPixels = (element: HTMLImageElement | HTMLCanvasElement) => {
      const width =
        element instanceof HTMLImageElement
          ? element.naturalWidth || element.width
          : element.width;
      const height =
        element instanceof HTMLImageElement
          ? element.naturalHeight || element.height
          : element.height;
      if (!width || !height) {
        return { error: 'empty-image', colors: [], counts: {}, sampleCount: 0 };
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        return { error: 'no-context', colors: [], counts: {}, sampleCount: 0 };
      }
      try {
        if (element instanceof HTMLImageElement) {
          context.drawImage(element, 0, 0);
        } else {
          context.drawImage(element, 0, 0, width, height);
        }
        const imageData = context.getImageData(0, 0, width, height);
        const analyzed = analyzePixelData(imageData.data, width, height);
        return { ...analyzed, error: undefined };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'canvas-read-failed',
          colors: [],
          counts: {},
          sampleCount: 0,
        };
      }
    };

    containers.forEach((container) => {
      const root = document.querySelector(container);
      if (!root) return;
      const tiles = Array.from(root.querySelectorAll('img, canvas')).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 64 && rect.height >= 64;
      });

      tiles.forEach((tile, index) => {
        const src = tile instanceof HTMLImageElement ? tile.currentSrc || tile.src : null;
        const tileId = tileIdFromUrl(src, `${container}-tile-${index}`);
        const analyzed = readElementPixels(tile as HTMLImageElement | HTMLCanvasElement);
        results.push({
          container,
          index,
          tileId,
          src: trimSrc(src),
          colors: analyzed.colors,
          colorCounts: analyzed.counts,
          sampleCount: analyzed.sampleCount,
          error: analyzed.error,
        });
      });
    });

    return results;
  }, { containers });
}

test('traffic colors display on tiles', async ({ page }) => {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  const leftEndpoint = page.getByLabel('Left side Tile Endpoint');
  if (await leftEndpoint.count()) {
    await leftEndpoint.selectOption({ label: 'Rc with cache' });
  }
  const rightEndpoint = page.getByLabel('Right side Tile Endpoint');
  if (await rightEndpoint.count()) {
    await rightEndpoint.selectOption({ label: 'Rc with cache' });
  }

  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('#before') ||
          document.querySelector('#after') ||
          document.querySelector('[role="region"][aria-label="Map"]') ||
          document.querySelector('.maplibregl-map') ||
          document.querySelector('.mapboxgl-map'),
      ),
    { timeout: 30000 },
  );

  await page.waitForTimeout(2000);

  const containers = await page.evaluate(() => {
    const compareSelectors = ['#before', '#after'];
    const compare = compareSelectors.filter((selector) => document.querySelector(selector));
    if (compare.length > 0) {
      return compare;
    }

    const fallbackSelectors = [
      '[role="region"][aria-label="Map"]',
      '.maplibregl-map',
      '.mapboxgl-map',
    ];
    return fallbackSelectors.filter((selector) => document.querySelector(selector));
  });

  if (containers.length === 0) {
    containers.push('body');
  }
  await page.waitForFunction(
    (selectors) =>
      selectors.some((selector) => {
        const root = document.querySelector(selector);
        if (!root) return false;
        const tiles = Array.from(root.querySelectorAll('img, canvas'));
        return tiles.some((tile) => {
          if (tile instanceof HTMLImageElement) {
            return tile.complete && tile.naturalWidth > 0;
          }
          if (tile instanceof HTMLCanvasElement) {
            return tile.width > 0 && tile.height > 0;
          }
          return false;
        });
      }),
    containers,
    { timeout: 30000 },
  );
  const tiles = await collectTrafficColors(page, containers);

  const summary = tiles.map((tile) => ({
    container: tile.container,
    tileId: tile.tileId,
    colors: tile.colors,
    sampleCount: tile.sampleCount,
    error: tile.error ?? null,
    src: tile.src,
  }));

  test.info().attach('traffic-colors', {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  });

  console.log('Traffic color summary:', JSON.stringify(summary, null, 2));

  expect(tiles.length).toBeGreaterThan(0);

  const tilesWithData = tiles.filter((tile) => !tile.error);
  expect(tilesWithData.length).toBeGreaterThan(0);

  const tilesWithColors = tilesWithData.filter((tile) => tile.colors.length > 0);
  expect(tilesWithColors.length).toBeGreaterThan(0);

  const colorsFound = new Set(tilesWithColors.flatMap((tile) => tile.colors));
  expect(colorsFound.size).toBeGreaterThan(0);
});
