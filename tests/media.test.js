import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImageUrl, mediaSuspicion, skinStats } from '../src/sw/media.js';
import { classifyImageWithVision, visionReady, VISION_SYSTEM_PROMPT } from '../src/sw/vision.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';

const settings = normalizeSettings(DEFAULT_SETTINGS);

function solid(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fn(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('肤色照片（有纹理、整片）→ 判定为裸露信号', () => {
  const frame = solid(64, 64, (x, y) => [200 + ((x * 7 + y * 13) % 40), 145 + ((x * 3) % 25), 125 + ((y * 5) % 22)]);
  const stats = skinStats(frame);
  assert.ok(stats.skinRatio > 0.9, `肤色占比 ${stats.skinRatio}`);
  assert.ok(stats.flatRatio < 0.85, '有纹理，不应被判为纯色块');
  const suspicion = mediaSuspicion(stats, settings);
  assert.equal(suspicion.suspicious, true);
  assert.equal(suspicion.blocked, true);
});

test('风景照（天空/草地/云）→ 无信号', () => {
  const frame = solid(64, 64, (x, y) => {
    const band = Math.floor(y / 21) % 3;
    if (band === 0) return [80, 150, 230];
    if (band === 1) return [70, 165, 80];
    return [225, 230, 240];
  });
  const stats = skinStats(frame);
  assert.ok(stats.skinRatio < 0.05, `肤色占比 ${stats.skinRatio}`);
  assert.equal(mediaSuspicion(stats, settings).suspicious, false);
});

test('纯色块（表情/占位图）即使全是肤色也被忽略', () => {
  const frame = solid(32, 32, () => [214, 178, 148]);
  const stats = skinStats(frame);
  assert.equal(stats.skinRatio, 1);
  assert.ok(stats.flatRatio > 0.9);
  const suspicion = mediaSuspicion(stats, settings);
  assert.equal(suspicion.suspicious, false, 'flatRatio 保护必须生效');
  assert.deepEqual(suspicion.reasons, ['flat_image_ignored']);
});

test('局部肤色（小面积）不构成信号', () => {
  const frame = solid(64, 64, (x, y) => (x < 10 && y < 10 ? [205, 155, 130] : [60, 90, 160]));
  const stats = skinStats(frame);
  assert.ok(stats.skinRatio < 0.1);
  assert.equal(mediaSuspicion(stats, settings).suspicious, false);
});

test('空帧不会崩，返回零值', () => {
  const stats = skinStats(null);
  assert.equal(stats.pixels, 0);
  assert.equal(mediaSuspicion(stats, settings).suspicious, false);
});

test('analyzeImageUrl：注入假运行时，不联网也能走完整流程', async () => {
  const skin = solid(40, 40, (x, y) => [200 + ((x + y) % 30), 150 + (y % 20), 130 + (x % 15)]);
  class FakeCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        drawImage: () => {},
        getImageData: () => skin,
      };
    }
  }
  const result = await analyzeImageUrl('https://pbs.twimg.com/media/x.jpg?name=small', {
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    createImageBitmapImpl: async () => ({ width: 40, height: 40, close: () => {} }),
    OffscreenCanvasImpl: FakeCanvas,
  });
  assert.equal(result.ok, true);
  assert.ok(result.stats.skinRatio > 0.9);
  assert.equal(result.width, 40);
});

test('analyzeImageUrl：非图片类型与 HTTP 错误都返回 ok=false', async () => {
  const notImage = await analyzeImageUrl('https://x.test/a', {
    fetchImpl: async () => new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } }),
    createImageBitmapImpl: async () => ({ width: 1, height: 1, close: () => {} }),
    OffscreenCanvasImpl: class {},
  });
  assert.deepEqual({ ok: notImage.ok, error: notImage.error }, { ok: false, error: 'not_image:text/html' });

  const http500 = await analyzeImageUrl('https://x.test/a', {
    fetchImpl: async () => new Response('boom', { status: 500 }),
    createImageBitmapImpl: async () => ({ width: 1, height: 1, close: () => {} }),
    OffscreenCanvasImpl: class {},
  });
  assert.equal(http500.ok, false);
  assert.equal(http500.error, 'http_500');
});

test('analyzeImageUrl：运行时缺失时优雅失败', async () => {
  const result = await analyzeImageUrl('https://x.test/a', { fetchImpl: undefined, createImageBitmapImpl: undefined, OffscreenCanvasImpl: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_image_runtime');
});

function visionAnswer(body) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('视觉适配器：默认关闭时直接拒绝', async () => {
  const result = await classifyImageWithVision('https://x.test/a.jpg', normalizeSettings(DEFAULT_SETTINGS).media, {
    fetchImpl: async () => visionAnswer({ adult: true, confidence: 0.9 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'vision_disabled');
});

test('视觉适配器：请求体包含 image_url 与严格模式提示', async () => {
  const cfg = normalizeSettings({
    media: { visionEnabled: true, visionBaseURL: 'https://vision.test/v1', visionModel: 'vl-1', visionApiKey: 'k' },
  }).media;
  assert.equal(visionReady(cfg), true);
  let captured = null;
  const result = await classifyImageWithVision('https://x.test/a.jpg', cfg, {
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return visionAnswer({ adult: true, confidence: 0.81, reason: 'explicit' });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.adultProb, 0.81);
  assert.equal(result.confidence, 0.81);
  assert.equal(captured.url, 'https://vision.test/v1/chat/completions');
  assert.equal(captured.init.headers.authorization, 'Bearer k');
  const content = captured.body.messages[1].content;
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'https://x.test/a.jpg');
  assert.equal(captured.body.temperature, 0);
  assert.match(captured.body.messages[0].content, /never converse/i);
  assert.ok(VISION_SYSTEM_PROMPT.includes('adult=false'), '不确定时必须偏向 false');
});

test('视觉适配器：回答不合规 → ok=false，不做修补', async () => {
  const cfg = normalizeSettings({ media: { visionEnabled: true, visionBaseURL: 'https://v.test', visionModel: 'm' } }).media;
  const cases = [
    { body: 'no json here', error: 'invalid_answer' },
    { body: JSON.stringify({ adult: 'yes', confidence: 0.9 }), error: 'invalid_answer' },
    { body: JSON.stringify({ adult: true, confidence: 5 }), error: 'invalid_confidence' },
  ];
  for (const item of cases) {
    const result = await classifyImageWithVision('https://x.test/a.jpg', cfg, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: item.body } }] }), { status: 200 }),
    });
    assert.equal(result.ok, false, item.body);
    assert.equal(result.error, item.error, item.body);
  }
});

test('视觉适配器：非 2xx 与网络异常都返回错误字符串', async () => {
  const cfg = normalizeSettings({ media: { visionEnabled: true, visionBaseURL: 'https://v.test', visionModel: 'm' } }).media;
  const http = await classifyImageWithVision('u', cfg, { fetchImpl: async () => new Response('x', { status: 429 }) });
  assert.equal(http.error, 'http_429');
  const boom = await classifyImageWithVision('u', cfg, {
    fetchImpl: async () => {
      throw new Error('dns down');
    },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /dns down/);
});
