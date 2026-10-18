import QRCode from "qrcode";
import type { QRCodeErrorCorrectionLevel } from "qrcode";

/**
 * QR rendering.
 *
 * `QRCode.toCanvas` re-encodes and repaints the whole symbol on every frame.
 * Instead we encode each frame once into a tiny module-resolution canvas and
 * blit that into the visible canvas with nearest-neighbour scaling, which is
 * both much cheaper and perfectly crisp (one QR module maps to an integer
 * number of screen pixels).
 */

export type QrInfo = {
  version: number;
  modules: number;
};

type CacheEntry = QrInfo & { canvas: HTMLCanvasElement };

const QUIET_ZONE = 4;
const MAX_CACHE_ENTRIES = 192;
const cache = new Map<string, CacheEntry>();

export function qrInfo(text: string, ecc: QRCodeErrorCorrectionLevel): QrInfo {
  const entry = getEntry(text, ecc);
  return { version: entry.version, modules: entry.modules };
}

export type RenderOptions = {
  ecc: QRCodeErrorCorrectionLevel;
  /** Target pixel size of a single QR cell. */
  cellSize: number;
};

export type RenderResult = QrInfo & { cells: number };

export function renderQrCells(
  container: HTMLElement,
  texts: readonly string[],
  options: RenderOptions
): RenderResult | null {
  const canvases = syncCells(container, texts.length);
  const columns = texts.length >= 9 ? 3 : texts.length >= 4 ? 2 : 1;
  container.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  container.dataset.columns = String(columns);

  // Prefer the real layout size so the module grid stays an integer number of
  // device pixels on large, high-DPI screens.
  const available = container.clientWidth > 0 ? container.clientWidth : options.cellSize;
  const density = Math.min(2, window.devicePixelRatio || 1);
  const target = Math.max(64, Math.round((available / columns) * density));
  let info: QrInfo | null = null;

  for (let index = 0; index < texts.length; index += 1) {
    const entry = getEntry(texts[index], options.ecc);
    if (info === null) {
      info = { version: entry.version, modules: entry.modules };
    }

    const canvas = canvases[index];
    const scale = Math.min(8, Math.max(1, Math.round(target / entry.canvas.width)));
    const pixels = entry.canvas.width * scale;

    if (canvas.width !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }

    context.imageSmoothingEnabled = false;
    context.drawImage(entry.canvas, 0, 0, pixels, pixels);
  }

  return info === null ? null : { ...info, cells: texts.length };
}

export function clearQrCells(container: HTMLElement): void {
  container.replaceChildren();
}

function syncCells(container: HTMLElement, count: number): HTMLCanvasElement[] {
  while (container.childElementCount < count) {
    container.append(document.createElement("canvas"));
  }
  while (container.childElementCount > count) {
    container.lastElementChild?.remove();
  }

  return Array.from(container.querySelectorAll("canvas"));
}

function getEntry(text: string, ecc: QRCodeErrorCorrectionLevel): CacheEntry {
  const key = `${ecc}:${text}`;
  const cached = cache.get(key);

  if (cached) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  const modules = qr.modules.size;
  const side = modules + QUIET_ZONE * 2;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;

  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(side, side);
    image.data.fill(255);

    for (let y = 0; y < modules; y += 1) {
      for (let x = 0; x < modules; x += 1) {
        if (qr.modules.data[y * modules + x]) {
          const offset = ((y + QUIET_ZONE) * side + (x + QUIET_ZONE)) * 4;
          image.data[offset] = 0;
          image.data[offset + 1] = 0;
          image.data[offset + 2] = 0;
        }
      }
    }

    context.putImageData(image, 0, 0);
  }

  const entry: CacheEntry = { canvas, version: qr.version, modules };
  cache.set(key, entry);

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }

  return entry;
}
