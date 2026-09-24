import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FARM_MIN_CHARS,
  createFarmTracker,
  farmKey,
  farmSimilarity,
  hasRepeatedLine,
  normalizeFarmText,
} from '../src/sw/farm.js';

test('归一化：吃掉 emoji、标点、大小写、零宽字符 —— 换装躲不掉', () => {
  const a = normalizeFarmText('应该没人比我玩的开了吧🤣💖我福不黑不信你看');
  const b = normalizeFarmText('应该没人比我玩的开了吧 😭 我福不黑 不信你看！');
  assert.equal(a, b);
  assert.equal(normalizeFarmText('ＡＢＣ１２３'), 'abc123');
  assert.equal(normalizeFarmText('Only\u200bFans'), 'onlyfans');
});

test('太短的内容不参与农场判定（避免大众短语误伤）', () => {
  assert.equal(farmKey('哈哈'), null);
  assert.equal(farmKey('太好了太好了'), null, `短于 ${FARM_MIN_CHARS} 个有效字符`);
  assert.ok(farmKey('应该没人比我玩的开了吧我福不黑不信你看'));
});

test('农场：默认 2 个不同账号即命中；同账号重复不算', () => {
  const tracker = createFarmTracker({ windowMs: 60000, now: () => 0 });
  const text = '太阳射☀️不进去的地方💪你可以';
  assert.equal(tracker.record(text, 'lisa82am4', { nowMs: 1000 }).hit, false);
  assert.equal(tracker.record(text, 'lisa82am4', { nowMs: 2000 }).hit, false, '同账号重复不算新账号');
  const second = tracker.record(text, 'marie61ff2', { nowMs: 3000 });
  assert.equal(second.hit, true, '默认阈值是 2 个不同账号');
  assert.equal(second.accounts, 2);
  const third = tracker.record(text, 'lori73sv6', { nowMs: 4000 });
  assert.equal(third.accounts, 3);
});

test('农场：窗口外的时间戳被淘汰，不会把隔天的话算成一个农场', () => {
  const tracker = createFarmTracker({ minAccounts: 3, windowMs: 10000 });
  tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'a', { nowMs: 0 });
  tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'b', { nowMs: 1000 });
  const late = tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'c', { nowMs: 100000 });
  assert.equal(late.hit, false, 'a/b 已过期，只剩 c');
});

test('农场：2 个账号时也要求内容够长（短句不参与）', () => {
  const tracker = createFarmTracker({ windowMs: 60000 });
  assert.equal(tracker.record('好的', 'a', { nowMs: 0 }).hit, false, '短句没有农场键');
  assert.equal(tracker.record('好的', 'b', { nowMs: 10 }).hit, false);
});

test('农场：命中后不会重复计数，配置可热更新', () => {
  const tracker = createFarmTracker({ minAccounts: 2, windowMs: 60000 });
  const text = '应该没人比我玩的开了吧我福不黑不信你看';
  assert.equal(tracker.record(text, 'a', { nowMs: 0 }).hit, false);
  assert.equal(tracker.record(text, 'b', { nowMs: 10 }).hit, true);
  assert.equal(tracker.record(text, 'a', { nowMs: 20 }).hit, true, '老账号再来一条仍是命中');

  tracker.configure({ minAccounts: 5 });
  assert.equal(tracker.record(text, 'c', { nowMs: 30 }).hit, false, '配置提高后需要 5 个账号');
  tracker.clear();
  assert.equal(tracker.size(), 0);
});

test('农场键与内容脚本里的实现必须逐字一致（防两处漂移）', async () => {
  await import('../src/content/extract.js'); // 传统脚本，靠副作用挂到 globalThis
  const contentFarmKey = globalThis.JevXExtract.farmKey;
  assert.equal(typeof contentFarmKey, 'function');
  const samples = [
    '应该没人比我玩的开了吧🤣💖我福不黑不信你看',
    '太阳射☀️不进去的地方💪你可以',
    'ＡＢＣ１２３ 这是全角',
    'x'.repeat(9),
    'x'.repeat(10),
    '',
  ];
  for (const sample of samples) {
    assert.equal(contentFarmKey(sample), farmKey(sample), sample);
  }
});

test('近似去重：插入垃圾字符/丢掉前缀/重复两遍都算同一段（真站样本）', () => {
  const a = farmKey('比我好看的没我骚蝎🐾比我骚的没我好看');
  const b = farmKey('比我好看的没我骚🐾💩比我骚的没我好看');
  const c = farmKey('比我好看的没我骚🐾💩比我骚的没我好看\n比我好看的没我骚🐾💩比我骚的没我好看');
  assert.ok(farmSimilarity(a, b) >= 0.8, `插入一个字符后相似度 ${farmSimilarity(a, b)}`);
  assert.equal(b, c, '重复写两遍会折叠成一遍');
  assert.ok(farmSimilarity(a, c) >= 0.8);

  const d = farmKey('应该没人比我玩的开了吧我福不黑不信你看');
  const e = farmKey('没人比我玩的开了吧我福不黑不信你看');
  assert.ok(farmSimilarity(d, e) >= 0.8, `丢前缀后相似度 ${farmSimilarity(d, e)}`);

  // 无关文案必须分开
  assert.ok(farmSimilarity(a, e) < 0.3, `无关文案相似度 ${farmSimilarity(a, e)}`);
  assert.equal(farmSimilarity(farmKey('今天天气不错我们一起去公园散步吧'), a), 0);
});

test('聚类：两个账号发近似文案（各插不同垃圾字符）即命中', () => {
  const tracker = createFarmTracker();
  const first = tracker.record('比我好看的没我骚蝎🐾比我骚的没我好看', 'MaribelTebhz');
  const second = tracker.record('比我好看的没我骚🐾💩比我骚的没我好看\n比我好看的没我骚🐾💩比我骚的没我好看', 'ShanteUusakr');
  assert.equal(first.hit, false);
  assert.equal(second.hit, true);
  assert.equal(second.accounts, 2);
  assert.ok(second.similarity >= 0.8, `相似度 ${second.similarity}`);
  assert.equal(second.samples.length, 2, '样本列表用于页面侧追溯隐藏');
  assert.equal(tracker.size(), 1, '应聚成同一个簇');

  // 无关文案不会并进这个簇
  const other = tracker.record('今天天气不错我们一起去公园散步吧顺便看看新开的书店', 'normaluser');
  assert.equal(other.accounts, 1);
  assert.equal(tracker.size(), 2);
});

test('重复行检测：同一条推文里同一句写两遍', () => {
  assert.equal(hasRepeatedLine('比我好看的没我骚🐾💩比我骚的没我好看\n比我好看的没我骚🐾💩比我骚的没我好看'), true);
  assert.equal(hasRepeatedLine('今天天气不错。我们一起去公园散步吧。'), false);
  assert.equal(hasRepeatedLine('好的'), false, '太短不算');
});

test('内容脚本侧的近似比较与 SW 侧一致（防两处漂移）', async () => {
  await import('../src/content/extract.js');
  const contentSimilar = globalThis.JevXExtract.farmSimilar;
  assert.equal(typeof contentSimilar, 'function');
  const samples = [
    '比我好看的没我骚蝎比我骚的没我好看',
    '比我好看的没我骚比我骚的没我好看',
    '没人比我玩的开了吧我福不黑不信你看',
    '今天天气不错我们一起去公园散步吧',
  ];
  for (const x of samples) {
    for (const y of samples) {
      assert.equal(contentSimilar(x, y), farmSimilarity(x, y), `${x.slice(0, 6)} ~ ${y.slice(0, 6)}`);
    }
  }
});

test('序列化 / 恢复：Service Worker 重启后农场簇仍在', () => {
  const first = createFarmTracker();
  first.record('没人比我玩的开了吧我福不黑不信你看', 'aaa'); // 用真实时间戳，否则恢复时会被窗口淘汰
  const snapshot = first.serialize();

  const second = createFarmTracker();
  assert.equal(second.size(), 0);
  const restored = second.restore(snapshot);
  assert.equal(restored, 1, '恢复出 1 个簇');
  const again = second.record('没人比我玩的开了吧我福不黑不信你看', 'bbb');
  assert.equal(again.hit, true, '重启后第二个账号就能凑够农场');
  assert.equal(again.accounts, 2);
});

test('恢复时会淘汰超过窗口的旧簇', () => {
  const a = createFarmTracker({ windowMs: 1000 });
  a.record('没人比我玩的开了吧我福不黑不信你看', 'aaa');
  const snapshot = a.serialize();
  snapshot.clusters[0].ts = Date.now() - 60_000;
  const b = createFarmTracker({ windowMs: 1000 });
  assert.equal(b.restore(snapshot), 0);
});

/**
 * 真站样本（用户截图里 X 标的「可能的垃圾信息」）：
 * 两个账号发同一句 `只入身体…不入生活`，只在中间各插了两个不同 emoji。
 * 归一化后都是 8 个有效字符 —— 阈值 10 会让这对**教科书级**的农场整条不参与判定。
 */
test('农场：真站样本「同句各插不同 emoji」在 8 个有效字符时也要聚成农场', () => {
  const tracker = createFarmTracker({ windowMs: 60000 });
  const a = '只入身体🥦🌰不入生活';
  const b = '只入身体🦵💪不入生活';
  assert.equal(farmKey(a), '只入身体不入生活', 'emoji 必须被归一化掉');
  assert.equal(farmKey(a), farmKey(b));
  assert.equal(tracker.record(a, 'jennifer73pe6', { nowMs: 1000 }).hit, false);
  const second = tracker.record(b, 'jessica31kz6', { nowMs: 2000 });
  assert.equal(second.hit, true, '2 个不同账号 + 同一句（去 emoji 后相同）');
  assert.equal(second.accounts, 2);
});

test('农场：归一化后 7 个有效字符仍不参与（阈值 8 的边界）', () => {
  assert.equal(farmKey('只入身体不入生'), null, '7 个字符');
  assert.equal(farmKey('只入身体不入生活'), '只入身体不入生活', '8 个字符刚好达标');
  assert.equal(farmKey('太好了太好了'), null, '6 个字符的大众短语仍然排除');
});
