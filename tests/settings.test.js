import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_PRESETS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveApi,
} from '../src/sw/settings.js';
import { mergeKnown, hash32, RateWindow, truncate } from '../src/sw/util.js';

test('默认设置本身是合法且自洽的', () => {
  const s = normalizeSettings(DEFAULT_SETTINGS);
  assert.equal(s.schema, 2);
  assert.equal(s.api.preset, 'typesafe');
  assert.ok(s.thresholds.hideNoul <= s.thresholds.blockNoul);
  assert.ok(s.thresholds.hideConfidence <= s.thresholds.blockConfidence);
  assert.deepEqual(normalizeSettings(s), s, 'normalize 必须幂等');
});

test('未知字段被丢弃，数值被夹紧', () => {
  const s = normalizeSettings({
    enabled: 'yes',
    evil: 'payload',
    thresholds: { blockNoul: 42, hideNoul: -3, mediaBlockedRatio: 99 },
    budget: { concurrency: 1000, maxJevPerDay: 1.5 },
  });
  assert.equal(s.evil, undefined);
  assert.equal(s.enabled, true);
  assert.equal(s.action.dryRun, DEFAULT_SETTINGS.action.dryRun);
  assert.ok(s.thresholds.blockNoul <= 1 && s.thresholds.blockNoul >= 0.5);
  assert.equal(s.thresholds.hideNoul, 0.3);
  assert.equal(s.thresholds.mediaBlockedRatio, 1);
  assert.equal(s.budget.concurrency, 8);
  assert.equal(s.budget.maxJevPerDay, 2, '1.5 四舍五入为 2');
});

test('hide 阈值不会高于 block 阈值', () => {
  const s = normalizeSettings({ thresholds: { blockNoul: 0.6, hideNoul: 0.95, blockConfidence: 0.4, hideConfidence: 0.9 } });
  assert.equal(s.thresholds.hideNoul, 0.6);
  assert.equal(s.thresholds.hideConfidence, 0.4);
});

test('双确认阈值被夹紧在合理区间', () => {
  const s = normalizeSettings({ thresholds: { dualAdult: 5, dualSolicitation: 0.1, dualConfidence: 'x' } });
  assert.equal(s.thresholds.dualAdult, 1);
  assert.equal(s.thresholds.dualSolicitation, 0.5);
  assert.equal(s.thresholds.dualConfidence, DEFAULT_SETTINGS.thresholds.dualConfidence);
});

test('白名单去重、去 @、小写化', () => {
  const s = normalizeSettings({ whitelist: { handles: ['@Foo', 'foo', ' Bar '], keywords: ['a', 'a', ' b '] } });
  assert.deepEqual(s.whitelist.handles, ['foo', 'bar']);
  assert.deepEqual(s.whitelist.keywords, ['a', 'b']);
});

test('语义层默认值与冻结接口一致（α/β 只做展示，不影响判定）', () => {
  const s = normalizeSettings(null);
  assert.deepEqual(s.semantics, {
    enabled: true,
    reserveForFiltering: 50,
    beta: { enabled: true, threshold: 0.7, maxCandidates: 6, windowSize: 60, foldInFeed: true, foldInReplies: true, foldLowSignal: true },
    alpha: { enabled: true, onlyInReplies: true, threshold: 0.7, minReferences: 3, maxReferences: 12 },
    emotion: { enabled: true, mode: 'fold' },
    maxPerMinute: 10,
    maxPerDay: 300,
  });
});

test('语义层设置被夹紧，且弹窗的局部 patch 不会清掉其它字段', () => {
  const s = normalizeSettings({
    semantics: {
      enabled: 'yes',
      reserveForFiltering: -5,
      beta: { threshold: 9, maxCandidates: -3, windowSize: 999999, foldInFeed: 0 },
      alpha: { threshold: -1, minReferences: 0, maxReferences: 2 },
      maxPerMinute: 99999,
      maxPerDay: 1.5,
    },
  });
  assert.equal(s.semantics.enabled, true);
  assert.equal(s.semantics.reserveForFiltering, 0);
  assert.equal(s.semantics.beta.threshold, 1);
  assert.equal(s.semantics.beta.maxCandidates, 0, '允许 0 = 本地不选候选');
  assert.equal(s.semantics.beta.windowSize, 500);
  assert.equal(s.semantics.beta.foldInFeed, false);
  assert.equal(s.semantics.beta.foldInReplies, true, '未提供的字段保留默认');
  assert.equal(s.semantics.alpha.threshold, 0);
  assert.equal(s.semantics.alpha.minReferences, 1);
  assert.equal(s.semantics.alpha.maxReferences, 2);
  assert.equal(s.semantics.maxPerMinute, 600);
  assert.equal(s.semantics.maxPerDay, 2);
  // 参考上限被抬到不低于下限，否则 α 永远无法判定
  const consistent = normalizeSettings({ semantics: { alpha: { minReferences: 5, maxReferences: 2 } } });
  assert.equal(consistent.semantics.alpha.maxReferences, 5);

  // 弹窗只 patch 一个开关时的形态（semantics.beta.enabled）
  const patched = mergeKnown(normalizeSettings(null), { semantics: { beta: { enabled: false } } });
  const merged = normalizeSettings(patched);
  assert.equal(merged.semantics.beta.enabled, false);
  assert.equal(merged.semantics.beta.threshold, 0.7, '其它 β 字段必须保留');
  assert.equal(merged.semantics.alpha.enabled, true, 'α 不受影响');
});

test('path 始终以 / 开头，baseURL 去掉尾部斜杠', () => {
  const s = normalizeSettings({ api: { baseURL: 'https://x.test///', path: 'v1/systemone' } });
  assert.equal(s.api.baseURL, 'https://x.test');
  assert.equal(s.api.path, '/v1/systemone');
});

test('resolveApi：zen 免密钥可用，typesafe 缺 key 不可用', () => {
  const zen = resolveApi({ api: { preset: 'zen' } });
  assert.equal(zen.baseURL, API_PRESETS.zen.baseURL);
  assert.equal(zen.model, 'jev-1.13-free');
  assert.equal(zen.ready, true);
  assert.equal(zen.keylessOk, true);

  const typesafe = resolveApi({ api: { preset: 'typesafe' } });
  assert.equal(typesafe.ready, false);
  assert.deepEqual(typesafe.missing, ['apiKey']);

  const custom = resolveApi({ api: { preset: 'custom', baseURL: 'http://127.0.0.1:9999', model: 'jev-test' } });
  assert.equal(custom.ready, true);
  assert.equal(custom.path, '/v1/systemone');
});

test('mergeKnown 只合并已知字段且深层合并', () => {
  const merged = mergeKnown({ a: 1, b: { c: 2, d: 3 } }, { a: 9, b: { c: 8, z: 1 }, z: 5 });
  assert.deepEqual(merged, { a: 9, b: { c: 8, d: 3 } });
});

test('hash32 稳定且区分大小写内容', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abC'));
  assert.match(hash32('随便什么'), /^[0-9a-f]{8}$/);
});

test('RateWindow 在窗口内计数并自动过期', () => {
  const w = new RateWindow(1000);
  assert.equal(w.tryTake(0, 2), true);
  assert.equal(w.tryTake(10, 2), true);
  assert.equal(w.tryTake(20, 2), false);
  assert.equal(w.count(30), 2);
  assert.equal(w.count(1500), 0, '窗口外的时间戳应被淘汰');
  assert.equal(w.tryTake(1500, 2), true);
});

test('truncate 保留上限长度', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});
