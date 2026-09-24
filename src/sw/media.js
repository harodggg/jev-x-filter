/**
 * 图片侧信号。
 *
 * 为什么图片不用 Jev：jev-systemone 的 `state` 只能是文本，Jev 是纯文本决策模型，
 * “看图”不在它的能力范围内。所以图片走两条路：
 *   1. 本地像素启发式（本文件，零成本、不出网、只看缩略图）；
 *   2. 可选的视觉模型适配器（vision.js，默认关闭，需自己配置 endpoint）。
 *
 * 本地启发式只给「可疑/极可能裸露」这类信号，**永远不能单独触发拉黑**
 * （见 gate.js 的不变量 I1）。它按设计会误伤：沙滩、肤色背景、大量肉的
 * 美食照都可能命中，因此只在文案已有弱信号时才作为佐证使用。
 */

/** 经典 RGB 肤色判据（Kovac 等人的人脸检测规则）。 */
function isSkinRgb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b;
}

/** HSV 肤色补充：覆盖柔和光照与偏暖肤色。 */
function isSkinHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.25 || s < 0.15 || s > 0.9) return false;
  let h = 0;
  const d = max - min;
  if (d === 0) h = 0;
  else if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h <= 50 || h >= 350;
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 统计一帧 RGBA 像素。
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} frame
 * @param {{grid?: number}} [opts]
 */
export function skinStats(frame, opts = {}) {
  const { data, width, height } = frame ?? {};
  const grid = opts.grid ?? 4;
  if (!data || !width || !height) {
    return { pixels: 0, skinRatio: 0, maxCellRatio: 0, dominantCells: 0, cells: 0, flatRatio: 0, texture: 0 };
  }
  const cells = Math.max(1, grid * grid);
  const cellSkin = new Array(cells).fill(0);
  const cellCount = new Array(cells).fill(0);
  const buckets = new Map();
  let skin = 0;
  let total = 0;
  let textureEdges = 0;
  let textureChecks = 0;

  for (let y = 0; y < height; y++) {
    const cy = Math.min(grid - 1, Math.floor((y / height) * grid));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const cell = cy * grid + Math.min(grid - 1, Math.floor((x / width) * grid));
      cellCount[cell]++;
      total++;
      if (isSkinRgb(r, g, b) || isSkinHsv(r, g, b)) {
        skin++;
        cellSkin[cell]++;
      }
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      if (x + 1 < width) {
        const j = i + 4;
        const diff = Math.abs(luminance(r, g, b) - luminance(data[j], data[j + 1], data[j + 2]));
        textureChecks++;
        if (diff > 24) textureEdges++;
      }
    }
  }

  let dominantCells = 0;
  let maxCellRatio = 0;
  for (let c = 0; c < cells; c++) {
    const ratio = cellCount[c] === 0 ? 0 : cellSkin[c] / cellCount[c];
    if (ratio > maxCellRatio) maxCellRatio = ratio;
    if (ratio >= 0.6) dominantCells++;
  }

  let modal = 0;
  for (const count of buckets.values()) if (count > modal) modal = count;

  return {
    pixels: total,
    skinRatio: total === 0 ? 0 : skin / total,
    maxCellRatio,
    dominantCells,
    cells,
    /** 单一颜色桶占比：接近 1 说明是纯色 UI 块/占位图，不是照片。 */
    flatRatio: total === 0 ? 0 : modal / total,
    /** 相邻像素亮度跳变比例：照片纹理强，纯色块接近 0。 */
    texture: textureChecks === 0 ? 0 : textureEdges / textureChecks,
  };
}

/** 把像素统计翻译成「可疑/裸露」信号（仍不是账号级动作的依据）。 */
export function mediaSuspicion(stats, settings) {
  const T = settings.thresholds;
  const out = { suspicious: false, blocked: false, reasons: [], skinRatio: stats?.skinRatio ?? 0 };
  if (!stats || !stats.pixels) return out;
  // 纯色块（表情/UI/占位图）即使整片都是肤色也不算证据。
  if (stats.flatRatio > 0.9) {
    out.reasons.push('flat_image_ignored');
    return out;
  }
  const half = Math.ceil((stats.cells ?? 16) / 2);
  if (
    stats.skinRatio >= T.mediaBlockedRatio &&
    stats.dominantCells >= half &&
    stats.flatRatio < 0.85
  ) {
    out.blocked = true;
    out.suspicious = true;
    out.reasons.push('skin_ratio_blocked');
    return out;
  }
  if (
    stats.skinRatio >= T.mediaSuspiciousRatio &&
    (stats.dominantCells >= Math.ceil((stats.cells ?? 16) / 3) || stats.texture >= 0.05)
  ) {
    out.suspicious = true;
    out.reasons.push('skin_ratio_suspicious');
  }
  return out;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * 下载图片（带扩展的 host 权限，因此不受页面 CORS 限制）并做像素统计。
 * 只取缩略图尺寸，不落盘、不上传、不进页面上下文。
 *
 * @param {string} url
 * @param {object} deps 可注入：{ fetchImpl, createImageBitmapImpl, OffscreenCanvasImpl, timeoutMs, maxSide }
 */
export async function analyzeImageUrl(url, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const makeBitmap = deps.createImageBitmapImpl ?? globalThis.createImageBitmap;
  const makeCanvas = deps.OffscreenCanvasImpl ?? globalThis.OffscreenCanvas;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const maxSide = deps.maxSide ?? 64;

  if (typeof fetchImpl !== 'function' || typeof makeBitmap !== 'function' || typeof makeCanvas !== 'function') {
    return { ok: false, error: 'no_image_runtime' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const type = res.headers?.get?.('content-type') ?? '';
    if (type && !type.startsWith('image/')) return { ok: false, error: `not_image:${type}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { ok: false, error: 'too_large' };
    const bitmap = await makeBitmap(new Blob([buf], { type: type || 'image/jpeg' }));
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    bitmap.close?.();
    return { ok: true, stats: skinStats(frame), width: bitmap.width, height: bitmap.height };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
