/**
 * 生成扩展图标（零依赖，PNG 编码见 tools/png.js）。
 * 图案：深色圆角底 + 红色禁止环 + 白色斜杠（“过滤”的通用视觉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'icons');

const BG = [21, 32, 43];
const RING = [244, 33, 46];
const FG = [255, 255, 255];

function pixel(size, x, y) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const outer = size * 0.42;
  const ringWidth = Math.max(1, size * 0.11);
  const corner = Math.max(0, Math.abs(dx) - (size * 0.5 - size * 0.16)) + Math.max(0, Math.abs(dy) - (size * 0.5 - size * 0.16));
  if (corner > size * 0.16) return [0, 0, 0, 0];
  if (dist <= outer && dist >= outer - ringWidth) return [...RING, 255];
  const diag = Math.abs(dx - dy) / Math.SQRT2;
  if (dist <= outer - ringWidth * 0.35 && diag < Math.max(1, size * 0.085)) return [...FG, 255];
  return [...BG, 255];
}

function build(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(size, x, y);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, build(size));
  console.log(`已生成 ${path.relative(path.resolve(HERE, '..'), file)} (${fs.statSync(file).size} 字节)`);
}
