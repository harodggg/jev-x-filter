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
  assert.equal(s.schema, 1);
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
