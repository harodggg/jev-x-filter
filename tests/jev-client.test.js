/**
 * Jev 契约测试：不联网，用注入的 fetch 逐字节检查我们发出去的请求，
 * 并验证官方客户端在我们这个运行环境（Service Worker，无 window）里的行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationError,
  JevClient,
  RateLimitError,
  ValidationError,
  choice,
  confidenceBand,
  isConfident,
  noul,
  score,
  validateQuestions,
} from '../src/vendor/jev-systemone/dist/index.js';
import { QID, buildQuestions, buildRequest, buildState, readAnswers } from '../src/sw/classifier.js';

const ANSWERS = {
  model: 'jev-test',
  answers: {
    adult: { type: 'noul', noul: 0.97 },
    solicitation: { type: 'noul', noul: 0.91 },
    category: {
      type: 'choice',
      choice: 'adult_solicitation',
      confidence: 0.93,
      probabilities: { adult_porn: 0.05, adult_solicitation: 0.93, suggestive: 0.01, ordinary: 0.01, other: 0 },
    },
    severity: { type: 'score', score: 3.1, confidence: 0.88, legend: {}, probabilities: { 0: 0, 1: 0.02, 2: 0.1, 3: 0.88 } },
  },
  usage: { input_tokens: 120, output_tokens: 40 },
};

function makeClient(fetchImpl, overrides = {}) {
  return new JevClient({
    preset: 'custom',
    baseURL: 'https://jev.test',
    path: '/v1/systemone',
    apiKey: 'test-key',
    defaultModel: 'jev-test',
    retry: { maxRetries: 0 },
    timeout: 2000,
    dangerouslyAllowBrowser: true,
    fetch: fetchImpl,
    ...overrides,
  });
}

test('buildQuestions 通过官方校验，且只使用三种类型', () => {
  const questions = buildQuestions();
  validateQuestions(questions);
  assert.equal(questions[QID.adult].type, 'noul');
  assert.equal(questions[QID.solicitation].type, 'noul');
  assert.equal(questions[QID.category].type, 'choice');
  assert.equal(questions[QID.severity].type, 'score');
  assert.equal(questions[QID.deceptive].type, 'noul', 'v0.3 起多了一条「是否欺骗/诱导」的证据');
  assert.equal(Object.keys(questions[QID.category].criteria).length, 9, '九个类别（含普通与都无法归类）');
  assert.ok(questions[QID.category].criteria.scam, '必须有诈骗类');
  assert.equal(questions[QID.category].criteria.other, null, '必须给“都不像”留出口');
  assert.equal(questions[QID.severity].criteria.length, 4, 'score 级别必须 2–10');
  for (const q of Object.values(questions)) {
    assert.ok(typeof q.instructions === 'string' && q.instructions.length > 20, '完整问题必须写在 instructions 里');
  }
});

test('buildState 把关键线索都带给模型，并截断超长文案', () => {
  const state = buildState({
    text: '同城约啪 加电报 t.me/abc',
    handle: 'Spam',
    displayName: '推广',
    context: 'recommended',
    media: ['https://pbs.twimg.com/media/a.jpg'],
    altText: 'a naked woman',
    cardText: 'adult site',
    quotedText: 'quoted spam',
    mediaSkinRatio: 0.83,
    visionAdultProb: 0.95,
    lang: 'zh',
  });
  assert.match(state, /POST TEXT:/);
  assert.match(state, /@Spam/);
  assert.match(state, /position=recommended; has_media=yes; media_count=1/);
  assert.match(state, /media_alt_text=a naked woman/);
  assert.match(state, /link_card_text=adult site/);
  assert.match(state, /local_image_skin_tone_ratio=0.830/);
  assert.match(state, /local_vision_adult_probability=0.950/);
  assert.ok(buildState({ text: 'x'.repeat(9000) }).length <= 4000);
});

test('readAnswers 把缺字段/异常值一律当作不确定', () => {
  assert.deepEqual(readAnswers(undefined), {
    adult: 0,
    solicitation: 0,
    deceptive: 0,
    category: 'other',
    categoryProbabilities: null,
    categoryConfidence: 0,
    severity: 0,
    severityConfidence: 0,
  });
  const odd = readAnswers({ adult: { noul: 5 }, category: { choice: 'nope', confidence: -1 }, severity: { score: 'x' } });
  assert.equal(odd.adult, 1, '超出 0..1 被夹紧');
  assert.equal(odd.category, 'other', '未知类别一律收敛到 other（安全侧：不隐藏）');
  assert.equal(odd.categoryConfidence, 0);
  assert.equal(odd.severity, 0);
});

test('线上协议：POST {baseURL}{path}，body 为 {state, questions, model}', async () => {
  const calls = [];
  const client = makeClient(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(ANSWERS), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const request = buildRequest({ text: '同城约啪 加电报', handle: 'spam', context: 'timeline', media: [] });
  const result = await client.systemOne(request);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://jev.test/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.match(calls[0].init.headers['User-Agent'], /^jev-systemone\//);
  assert.equal(calls[0].body.model, 'jev-test');
  assert.match(calls[0].body.state, /同城约啪/);
  assert.equal(calls[0].body.questions.adult.type, 'noul');
  assert.equal(Object.keys(calls[0].body.questions).length, 5);

  const view = readAnswers(result.answers);
  assert.equal(view.adult, 0.97);
  assert.equal(view.category, 'adult_solicitation');
  assert.equal(view.categoryConfidence, 0.93);
  assert.ok(isConfident(result.answers.category, 0.7));
  assert.equal(confidenceBand(result.answers.category.confidence), 'high');
});

test('模型可覆盖 defaultModel', async () => {
  const calls = [];
  const client = makeClient(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(ANSWERS), { status: 200 });
  });
  await client.systemOne({ state: 'x', questions: { q: noul('Is it yes?') }, model: 'jev-1.13' });
  assert.equal(calls[0].model, 'jev-1.13');
});

test('401 映射为 AuthenticationError 且不重试', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });
  });
  await assert.rejects(() => client.systemOne({ state: 'x', questions: { q: noul('?') } }), (error) => {
    assert.ok(error instanceof AuthenticationError);
    return true;
  });
  assert.equal(calls, 1);
});

test('429 映射为 RateLimitError；配置了重试时会重试', async () => {
  let calls = 0;
  const client = makeClient(
    async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'slow down' }), { status: 429, headers: { 'retry-after': '0' } });
    },
    { retry: { maxRetries: 1, backoffInitialMs: 1, backoffJitter: 0 } },
  );
  await assert.rejects(() => client.systemOne({ state: 'x', questions: { q: noul('?') } }), RateLimitError);
  assert.equal(calls, 2);
});

test('客户端侧校验会拒绝坏问题定义（不浪费一次调用）', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return new Response(JSON.stringify(ANSWERS), { status: 200 });
  });
  await assert.rejects(async () => {
    const bad = score('too few levels', ['only one']);
    await client.systemOne({ state: 'x', questions: { bad } });
  }, ValidationError);
  await assert.rejects(async () => {
    const bad = choice('no options', {});
    await client.systemOne({ state: 'x', questions: { bad } });
  }, ValidationError);
  await assert.rejects(() => client.systemOne({ questions: { q: noul('?') } }), ValidationError);
  await assert.rejects(
    () => client.systemOne({ state: 'x', questions: { bad: { type: 'unknown', instructions: 'x' } } }),
    ValidationError,
  );
  assert.equal(calls, 0, '坏问题必须在本地被拦下');
});

test('错误回答（HTTP 200 但非 JSON）不会被悄悄修补', async () => {
  const client = makeClient(async () => new Response('<html>502</html>', { status: 200 }));
  await assert.rejects(() => client.systemOne({ state: 'x', questions: { q: noul('?') } }));
});

test('浏览器环境守卫：有 window+document 时必须显式 dangerouslyAllowBrowser', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    globalThis.window = { document: {} };
    globalThis.document = {};
    assert.throws(
      () => new JevClient({ preset: 'custom', baseURL: 'https://x.test', apiKey: 'k', defaultModel: 'm', fetch: async () => new Response('{}') }),
      /browser/i,
    );
    assert.doesNotThrow(
      () =>
        new JevClient({
          preset: 'custom',
          baseURL: 'https://x.test',
          apiKey: 'k',
          defaultModel: 'm',
          dangerouslyAllowBrowser: true,
          fetch: async () => new Response('{}'),
        }),
    );
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});

test('Service Worker 环境（无 window）不需要危险开关', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const client = new JevClient({
    preset: 'custom',
    baseURL: 'https://jev.test',
    apiKey: 'k',
    defaultModel: 'm',
    retry: { maxRetries: 0 },
    fetch: async () => new Response(JSON.stringify(ANSWERS), { status: 200 }),
  });
  const result = await client.systemOne(buildRequest({ text: '约啪 加电报', handle: 'a' }));
  assert.equal(result.answers.adult.noul, 0.97);
});

test('Zen 预设允许无密钥构造（免费档）', () => {
  const client = new JevClient({ preset: 'zen', fetch: async () => new Response('{}') });
  assert.equal(client.baseURL, 'https://opencode.ai/zen');
  assert.equal(client.defaultModel, 'jev-1.13-free');
  assert.equal(client.path, '/v1/systemone');
});

test('预检问题：单问合法、只含 junk、答案读取健壮', async () => {
  const { buildJunkProbe, readJunkAnswer, JUNK_INSTRUCTIONS } = await import('../src/sw/classifier.js');
  const probe = buildJunkProbe();
  validateQuestions(probe);
  assert.deepEqual(Object.keys(probe), ['junk']);
  assert.equal(probe.junk.type, 'noul');
  assert.equal(probe.junk.instructions, JUNK_INSTRUCTIONS);
  assert.match(JUNK_INSTRUCTIONS, /timeline junk/);
  assert.match(JUNK_INSTRUCTIONS, /scam or fraud bait/);
  assert.ok(JUNK_INSTRUCTIONS.length > 100, '完整问题必须写在 instructions 里');

  assert.equal(readJunkAnswer({ junk: { type: 'noul', noul: 0.83 } }), 0.83);
  assert.equal(readJunkAnswer({ junk: { type: 'noul', noul: 5 } }), 1, '夹紧到 0..1');
  assert.equal(readJunkAnswer({ junk: {} }), null, '缺字段返回 null，绝不猜');
  assert.equal(readJunkAnswer(undefined), null);

  // 预检请求也能真的发出去（协议与四问一致）
  const seen = [];
  const client = makeClient(async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: 'jev-test', answers: { junk: { type: 'noul', noul: 0.83 } }, usage: {} }), { status: 200 });
  });
  const result = await client.systemOne({ state: 'POST TEXT: x', questions: probe });
  assert.equal(seen[0].questions.junk.type, 'noul');
  assert.equal(readJunkAnswer(result.answers), 0.83);
});
