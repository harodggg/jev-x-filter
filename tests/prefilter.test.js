import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, preScreen } from '../src/sw/prefilter.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';

const settings = normalizeSettings(DEFAULT_SETTINGS);

function tweet(overrides = {}) {
  return { id: '1', handle: 'someone', text: '', media: [], context: 'timeline', ...overrides };
}

test('normalizeText 处理全角、零宽字符与空白', () => {
  assert.equal(normalizeText('  约　啪  '), '约 啪');
  assert.equal(normalizeText('Only\u200bFans'), 'onlyfans');
  assert.equal(normalizeText('ＯＮＬＹＦＡＮＳ'), 'onlyfans', 'NFKC 把全角折成半角');
});

test('真实漏检样本：正文无害、引流写在显示名里（必须成为候选）', () => {
  // 2026-09 真站样本：显示名「🍑真实同城约p🍑主页联系🔞免费」，正文「那一夜你没有拒绝我😭🤣不是人机」
  const shot = preScreen(
    tweet({
      handle: 'JesseAlvarl3',
      displayName: '🍑真实同城约p🍑主页联系🔞免费',
      text: '那一夜你没有拒绝我😭🤣不是人机',
    }),
    settings,
  );
  assert.equal(shot.skip, null);
  assert.equal(shot.candidate, true, '显示名命中必须让这条进入模型判定');
  assert.ok(shot.score >= 5, `分数 ${shot.score}`);
  assert.ok(shot.nameReasons.includes('zh_solicit_jiaofu'));
  assert.ok(shot.nameReasons.includes('zh_profile_contact'));
  assert.equal(shot.strongNameHit, true, '「约p」属于本身即色情的规则，可触发「仅隐藏」');
});

test('显示名命中不会因为正文过短而被跳过', () => {
  const hit = preScreen(tweet({ displayName: '真实同城约p 主页联系', text: '嗯' }), settings);
  assert.equal(hit.skip, null);
  assert.equal(hit.candidate, true);
});

test('只有「链接在简介」这类非色情强特征 → 仍是候选，但不算 strongNameHit', () => {
  const linkInBio = preScreen(tweet({ displayName: '插画师 Alice', text: '新作品发布，链接在简介，欢迎看看我的主页' }), settings);
  assert.equal(linkInBio.candidate, true, '正常创作者也会写“链接在简介”，送模型确认而不是本地定罪');
  assert.equal(linkInBio.strongNameHit, false);
});

test('新闻语境只看正文：账号名里写「警方」不能洗白名字上的引流特征', () => {
  const hit = preScreen(tweet({ displayName: '警方通报小助手', text: '同城约p 主页联系' }), settings);
  assert.equal(hit.newsContext, false);
  assert.equal(hit.candidate, true);
});

test('中文强特征命中并送模型', () => {
  const hit = preScreen(tweet({ text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利' }), settings);
  assert.equal(hit.skip, null);
  assert.equal(hit.candidate, true);
  assert.ok(hit.score >= 3);
  assert.ok(hit.reasons.length > 0);
});

test('英文强特征命中', () => {
  for (const text of ['DM for menu, escort services in your city', 'my onlyfans is 50% off, nudes in bio', 'selling content, snap premium']) {
    const hit = preScreen(tweet({ text }), settings);
    assert.equal(hit.candidate, true, text);
  }
});

test('新闻语境把强特征降级（避免误杀治理类报道）', () => {
  const text = '警方通报：专项行动打击传播淫秽色情信息的违法网站，已查处多个约炮平台';
  const hit = preScreen(tweet({ text }), settings);
  assert.equal(hit.newsContext, true);
  assert.ok(hit.score <= 3, `降级后分数应偏低，实际 ${hit.score}`);
});

test('普通日常推文不触发候选', () => {
  const hit = preScreen(tweet({ text: '今天天气不错，我们一起去公园散步吧，顺便看看新开的书店。' }), settings);
  assert.equal(hit.candidate, false);
  assert.equal(hit.skip, null);
});

test('白名单账号直接跳过', () => {
  const scoped = normalizeSettings({ ...DEFAULT_SETTINGS, whitelist: { handles: ['friend'], keywords: [] } });
  const hit = preScreen(tweet({ handle: 'Friend', text: '约啪 加电报' }), scoped);
  assert.equal(hit.skip, 'whitelisted_handle');
  assert.equal(hit.candidate, false);
});

test('白名单关键词直接跳过', () => {
  const scoped = normalizeSettings({ ...DEFAULT_SETTINGS, whitelist: { handles: [], keywords: ['学术讨论'] } });
  const hit = preScreen(tweet({ text: '色情内容的学术讨论 / 性教育研究' }), scoped);
  assert.equal(hit.skip, 'whitelisted_keyword:学术讨论');
});

test('自己的推文跳过；完全空的节点跳过；但「解析不出作者、有正文」仍要分析', () => {
  assert.equal(preScreen(tweet({ isOwn: true, text: '约啪' }), settings).skip, 'own_tweet');
  assert.equal(preScreen({ id: '1', handle: '', displayName: '', text: '', media: [], context: 'timeline' }, settings).skip, 'no_author');
  // X 是渐进式水合：作者链接可能晚于正文出现。隐藏只作用于这条推文本身，
  // 所以宁可继续分析，也不要因为一时拿不到 @handle 就放行。
  const partial = preScreen(tweet({ handle: '', text: '同城约p 加电报 t.me/x' }), settings);
  assert.equal(partial.skip, null);
  assert.equal(partial.candidate, true);
});

test('scope 关闭时按位置跳过', () => {
  const noReplies = normalizeSettings({ ...DEFAULT_SETTINGS, scope: { ...DEFAULT_SETTINGS.scope, replies: false } });
  assert.equal(preScreen(tweet({ text: '约啪', context: 'reply' }), noReplies).skip, 'scope_replies_off');
  const noRec = normalizeSettings({ ...DEFAULT_SETTINGS, scope: { ...DEFAULT_SETTINGS.scope, recommended: false } });
  assert.equal(preScreen(tweet({ text: '约啪', context: 'recommended' }), noRec).skip, 'scope_recommended_off');
  const noTimeline = normalizeSettings({ ...DEFAULT_SETTINGS, scope: { ...DEFAULT_SETTINGS.scope, timeline: false } });
  assert.equal(preScreen(tweet({ text: '约啪', context: 'timeline' }), noTimeline).skip, 'scope_timeline_off');
});

test('超短且无媒体跳过；超短但有媒体标记为短文本+媒体', () => {
  assert.equal(preScreen(tweet({ text: '嗯' }), settings).skip, 'too_short_no_media');
  const withMedia = preScreen(tweet({ text: '看', media: ['https://pbs.twimg.com/media/a.jpg?name=small'] }), settings);
  assert.equal(withMedia.skip, null);
  assert.equal(withMedia.shortWithMedia, true);
  assert.equal(withMedia.candidate, false, '只发图不靠预筛结论，交给媒体与模型');
});

test('纯链接推文被视为短文本+媒体形态', () => {
  const hit = preScreen(
    tweet({ text: 'https://t.co/abcdefg', media: ['https://pbs.twimg.com/media/a.jpg?name=small'] }),
    settings,
  );
  assert.equal(hit.shortWithMedia, true);
});

test('一条弱特征不足以触发候选，两条弱特征可以', () => {
  const one = preScreen(tweet({ text: '这里有资源分享' }), settings);
  assert.equal(one.candidate, false);
  assert.equal(one.score, 1);
  const two = preScreen(tweet({ text: '这里有资源分享，还有极品学生妹' }), settings);
  assert.ok(two.score >= 2, `两条弱特征应累计到 2 分，实际 ${two.score}`);
  assert.equal(two.candidate, true);
});

test('乱码账号名启发式：只认结构、不用词表；单独不足以隐藏', async () => {
  const { looksRandomName } = await import('../src/sw/prefilter.js');
  assert.equal(looksRandomName('yrmyzhcxvlkzpu', 'yrmyzh cxvlu').random, true);
  assert.equal(looksRandomName('cxvlu', '').random, true);
  for (const handle of ['JesseAlvarl3', 'alicewonder', 'system', 'spammer1', 'normal']) {
    assert.equal(looksRandomName(handle, '').random, false, handle);
  }
  // 中文名不该被当成乱码
  assert.equal(looksRandomName('李小明', '李小明').random, false);

  const bare = preScreen(tweet({ handle: 'yrmyzhcxvlkzpu', displayName: 'yrmyzh cxvlu', text: '晚上好呀朋友们' }), settings);
  assert.equal(bare.randomName, true);
  assert.equal(bare.score, 1, '乱码名只算一条弱特征');
  assert.equal(bare.candidate, false, '单独不足以让模型看它');
});

test('乱码账号名 + 一条弱特征 → 达到候选线（两条弱特征）', () => {
  const hit = preScreen(tweet({ handle: 'yrmyzhcxvlkzpu', displayName: 'yrmyzh cxvlu', text: '这里有资源分享' }), settings);
  assert.equal(hit.score, 2);
  assert.equal(hit.candidate, true);
});

test('「主页匹配/无套路匹配」话术（真站农场固定文案）直接成为候选', () => {
  const hit = preScreen(
    tweet({
      handle: 'ArethaLaur666',
      displayName: '💎主页匹配💎无套路匹配💎覆盖全国',
      text: '那一夜你没有拒绝我🤤🧠不是人机',
    }),
    settings,
  );
  assert.equal(hit.skip, null);
  assert.equal(hit.candidate, true);
  assert.ok(hit.nameReasons.includes('zh_profile_contact'), JSON.stringify(hit.nameReasons));
});

test('emoji 拆字规避：去符号后仍能命中（真站：处🐕男 / 处🔪男）', async () => {
  const { stripSymbols } = await import('../src/sw/prefilter.js');
  assert.equal(stripSymbols('祝你有美好的一天🟧处🐕男🚹恭喜 发财'), '祝你有美好的一天处男恭喜发财');
  assert.equal(stripSymbols('约　啪！'), '约啪');

  const hit = preScreen(
    tweet({
      handle: 'czex7Jacquline',
      displayName: '不药而愈丶❤️处男免费❤️',
      text: '祝你有美好的一天🟧处🐕男🚹恭喜 发财',
    }),
    settings,
  );
  assert.equal(hit.candidate, true);
  assert.ok(hit.reasons.includes('zh_solicit_weak_slang'));
  assert.equal(hit.score, 2, '显示名与正文各算一次弱特征');
});

test('同一句黑话同时出现在显示名与正文里 → 两分（两个独立信号）', () => {
  const both = preScreen(tweet({ displayName: '处男免费', text: '处男免费来聊' }), settings);
  assert.equal(both.score, 2);
  assert.equal(both.candidate, true);
  const onlyBody = preScreen(tweet({ displayName: '小明', text: '处男免费来聊' }), settings);
  assert.equal(onlyBody.score, 1, '只有正文命中时不算候选');
  assert.equal(onlyBody.candidate, false);
});

test('去符号不会让普通内容变成候选', async () => {
  const { stripSymbols } = await import('../src/sw/prefilter.js');
  assert.equal(stripSymbols('今天天气不错，我们一起去公园散步吧🌤️'), '今天天气不错我们一起去公园散步吧');
  const hit = preScreen(tweet({ displayName: '小明🌤️', text: '今天天气不错，我们一起去公园散步吧🌤️' }), settings);
  assert.equal(hit.candidate, false);
  assert.equal(hit.score, 0);
});

/**
 * X 标为「可能的垃圾信息」的分区：那条推文正文只有三个字（`已老实`），内容层完全无解，
 * 但 X 自己判过了。这个结构信号要做两件事：不让「正文过短」把它跳过 + 交给闸门给 review 下限。
 */
test('X 的「可能的垃圾信息」分区：过短正文不再被本地跳过，但要标出来', () => {
  const s = settings;
  const plain = preScreen(tweet({ text: '已老实' }), s);
  assert.equal(plain.skip, 'too_short_no_media', '普通情况下 3 个字无媒体仍然跳过（省调用）');
  assert.equal(plain.xSpamSection, false);

  const flagged = preScreen(tweet({ handle: 'for520vox', text: '已老实', spamSection: true }), s);
  assert.equal(flagged.skip, null, 'X 已标分区 → 不跳过');
  assert.equal(flagged.xSpamSection, true);
  // 这个信号不参与本地打分（不能靠它把分数推过候选线）
  assert.equal(flagged.score, 0);
  assert.equal(flagged.candidate, false);
});

test('X 的「可能的垃圾信息」分区也不绕过白名单/自己发的', () => {
  const s = settings;
  assert.equal(preScreen(tweet({ text: '已老实', spamSection: true, isOwn: true }), s).skip, 'own_tweet');
  const whitelisted = preScreen(tweet({ handle: 'friend', text: '已老实', spamSection: true }), {
    ...s,
    whitelist: { ...s.whitelist, handles: ['friend'] },
  });
  assert.equal(whitelisted.skip, 'whitelisted_handle');
});

/**
 * 真站样本（用户截图）：`只入身体😔😊不入生活` / `只入身体🥦🌰不入生活` / `只入身体🦵💪不入生活`
 * 是同一批农场账号的固定黑话。加规则前本地零信号，单条只能靠预检拿到 junk 0.69 → 只到「待确认」。
 */
test('黑话「只入身体…不入生活」是强特征：单条也会走完整判定', () => {
  for (const text of ['只入身体😔😊不入生活', '只入身体🥦🌰不入生活', '只进入身体，不进入生活']) {
    const r = preScreen(tweet({ handle: 'eomgduvbxj92qp', displayName: 'eomgdu vxbjw', text }), settings);
    assert.equal(r.skip, null, text);
    assert.equal(r.candidate, true, text);
    assert.ok(r.reasons.includes('zh_body_euphemism'), `${text} → ${r.reasons.join(',')}`);
    assert.ok(r.score >= 3, `${text} 分数 ${r.score}`);
  }
});

test('新闻/讨论语境引用这句黑话时降级成弱特征，不会因为引用就被隐藏', () => {
  const r = preScreen(
    tweet({ text: '警方通报：某平台以「只入身体不入生活」等话术招嫖，已查处多个窝点' }),
    settings,
  );
  assert.equal(r.newsContext, true, '新闻语境要被识别');
  assert.ok(r.reasons.includes('zh_body_euphemism'));
  assert.equal(r.score, 1, '强规则在新闻语境里降级为 1 分（不是 3 分）');
  // 仍然会让模型看一眼（和场景 A 的「警方通报…约炮平台」同一条路径）：降级发生在闸门，
  // 由模型判断这是新闻而不是招嫖，实测该路径下新闻样本一直是 ignore。
  assert.equal(r.candidate, true);
});

test('普通文本里的「身体」不会被这条规则误伤', () => {
  for (const text of ['锻炼身体，保持健康，每天跑步五公里', '入身体检报告拿到了']) {
    const r = preScreen(tweet({ text }), settings);
    assert.equal(r.reasons.includes('zh_body_euphemism'), false, text);
  }
});
