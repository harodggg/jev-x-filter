import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditor, AUDIT_SOURCE } from '../src/sw/audit.js';

test('无 webhook 时只写内存缓冲', async () => {
  const auditor = createAuditor({ version: 'test' });
  const result = await auditor.emit({ type: 'decision', tweet: { handle: 'a' } });
  assert.equal(result.delivered, false);
  assert.equal(result.error, 'no_webhook');
  assert.equal(auditor.list().length, 1);
  assert.equal(auditor.list()[0].source, AUDIT_SOURCE);
});

test('配置 webhook 后按约定 POST 事件体', async () => {
  const calls = [];
  const auditor = createAuditor({
    webhookUrl: 'https://audit.test/hook',
    version: 'test',
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    },
  });
  const result = await auditor.emit({ type: 'hidden', tweet: { id: '1', handle: 'spam' }, decision: { band: 'block', reasons: ['x'] } });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://audit.test/hook');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.keepalive, true);
  const body = calls[0].body;
  assert.equal(body.type, 'hidden');
  assert.equal(body.source, AUDIT_SOURCE);
  assert.equal(body.version, 'test');
  assert.equal(body.ts, 1_700_000_000_000);
  assert.equal(body.tweet.handle, 'spam');
  assert.equal(body.decision.band, 'block');
  assert.equal(new Date(body.iso).toISOString(), body.iso);
});

test('webhook 失败不抛异常、不阻塞主流程', async () => {
  const errors = [];
  const auditor = createAuditor({
    webhookUrl: 'https://audit.test/hook',
    onError: (error) => errors.push(String(error.message)),
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const result = await auditor.emit({ type: 'decision' });
  assert.equal(result.delivered, false);
  assert.match(result.error, /offline/);
  assert.deepEqual(errors, ['offline']);
  assert.equal(auditor.list().length, 1, '事件仍然留在内存缓冲里');
});

test('缓冲按上限裁剪，可清空', async () => {
  const auditor = createAuditor({ limit: 3 });
  for (let i = 0; i < 5; i++) await auditor.emit({ type: 'decision', i });
  assert.equal(auditor.list().length, 3);
  assert.deepEqual(auditor.list().map((e) => e.i), [2, 3, 4]);
  assert.equal(auditor.list()[0].id, '3', 'id 单调递增，便于排查');
  auditor.clear();
  assert.equal(auditor.list().length, 0);
});

test('webhook 地址可运行时更新（设置页改完不必重启）', async () => {
  const auditor = createAuditor({});
  auditor.setWebhookUrl('https://audit.test/hook');
  assert.equal(auditor.getWebhookUrl(), 'https://audit.test/hook');
  auditor.setWebhookUrl('');
  assert.equal(auditor.getWebhookUrl(), '');
});
