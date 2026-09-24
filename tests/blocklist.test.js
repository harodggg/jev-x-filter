import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBlocklist,
  hasHandle,
  importInto,
  isValidHandle,
  listStats,
  makeEntry,
  mergeEntries,
  normalizeHandle,
  parseImport,
  removeHandle,
  toExport,
} from '../src/sw/blocklist.js';

test('normalizeHandle 处理 @、URL、大小写与非法字符', () => {
  assert.equal(normalizeHandle('@Spammer'), 'spammer');
  assert.equal(normalizeHandle('https://x.com/Spammer/status/1'), 'spammer');
  assert.equal(normalizeHandle('x.com/spammer?ref=1'), 'spammer');
  assert.equal(normalizeHandle('  '), '');
  assert.equal(isValidHandle('valid_handle'), true);
  assert.equal(isValidHandle('too_long_handle_1234'), false);
  assert.equal(isValidHandle('bad-handle'), false);
  assert.equal(isValidHandle(''), false);
});

test('mergeEntries 去重并保留更严重的一档', () => {
  const first = mergeEntries(emptyBlocklist(), [makeEntry({ handle: 'a', band: 'hide', adult: 0.7, category: 'suggestive', reasons: ['x'] })]);
  const second = mergeEntries(first.list, [
    makeEntry({ handle: 'A', band: 'block', adult: 0.98, category: 'adult_porn', categoryConfidence: 0.9, reasons: ['y'], tweetId: '99' }),
  ]);
  assert.equal(second.list.entries.length, 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  const entry = second.list.entries[0];
  assert.equal(entry.handle, 'a');
  assert.equal(entry.bestBand, 'block');
  assert.equal(entry.bestAdult, 0.98);
  assert.equal(entry.bestCategory, 'adult_porn');
  assert.equal(entry.hits, 2);
  assert.deepEqual([...entry.reasons].sort(), ['x', 'y']);
  assert.deepEqual(entry.tweetIds, ['99']);
  assert.equal(hasHandle(second.list, '@A'), true);
});

test('parseImport 支持四种输入格式', () => {
  const schema = parseImport(toExport(mergeEntries(emptyBlocklist(), [makeEntry({ handle: 'one' })]).list));
  assert.equal(schema.ok, true);
  assert.equal(schema.format, 'jevx.blocklist');
  assert.equal(schema.entries[0].handle, 'one');

  const handles = parseImport('{"handles":["@a",{"handle":"b","reason":"x"}]}');
  assert.equal(handles.format, 'handles');
  assert.deepEqual(handles.entries.map((e) => e.handle), ['a', 'b']);

  const array = parseImport('["a","@B"]');
  assert.equal(array.format, 'array');
  assert.deepEqual(array.entries.map((e) => e.handle), ['a', 'b']);

  const lines = parseImport('# 注释\n@x\nhttps://x.com/y\nz, w\n');
  assert.equal(lines.format, 'lines');
  assert.deepEqual(lines.entries.map((e) => e.handle), ['x', 'y', 'z', 'w']);
});

test('parseImport 记录非法项但不失败', () => {
  const result = parseImport('["ok", "bad-handle", "way_too_long_handle_999"]');
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((e) => e.handle), ['ok']);
  assert.equal(result.errors.length, 2);
});

test('parseImport 对空输入与乱码输入给出 ok=false', () => {
  assert.equal(parseImport('').ok, false);
  assert.equal(parseImport('   ').ok, false);
});

test('importInto 合并并去重、保留白名单', () => {
  const base = mergeEntries(emptyBlocklist(), [makeEntry({ handle: 'keep' })]).list;
  const result = importInto(base, '["keep", "new"]');
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.list.entries.map((e) => e.handle).sort(), ['keep', 'new']);

  const withWhitelist = importInto(result.list, '{"schema":"jevx.blocklist","version":1,"entries":[],"whitelist":{"handles":["friend"],"keywords":["学术"]}}');
  assert.deepEqual(withWhitelist.list.whitelist.handles, ['friend']);
  assert.deepEqual(withWhitelist.list.whitelist.keywords, ['学术']);
});

test('removeHandle 与 listStats', () => {
  const merged = mergeEntries(emptyBlocklist(), [makeEntry({ handle: 'a', source: 'auto' }), makeEntry({ handle: 'b', source: 'import' })]).list;
  const after = removeHandle(merged, '@A');
  assert.deepEqual(after.entries.map((e) => e.handle), ['b']);
  const stats = listStats(after);
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.bySource, { import: 1 });
});

test('导出结果可被重新导入（round-trip）', () => {
  const merged = mergeEntries(emptyBlocklist(), [makeEntry({ handle: 'round', band: 'block', adult: 0.99 })]).list;
  const text = toExport(merged);
  const parsed = parseImport(text);
  assert.equal(parsed.ok, true);
  const reimported = importInto(emptyBlocklist(), text);
  assert.equal(reimported.list.entries[0].handle, 'round');
  assert.equal(reimported.list.entries[0].bestAdult, 0.99);
});

test('emptyBlocklist 形状稳定', () => {
  const empty = emptyBlocklist();
  assert.equal(empty.schema, 'jevx.blocklist');
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.whitelist, { handles: [], keywords: [] });
});
