/**
 * 审计日志：内存环形缓冲 + 可选 webhook。
 *
 * 为什么需要它：
 * - 用户要能回答“它到底拦了什么、为什么拦”，这是调阈值和发现误判的唯一依据；
 * - 自动拉黑是不可逆的账号动作，必须有可核对的事后流水；
 * - 端到端测试也靠它观测（本地 mock 服务器收 webhook 事件）。
 *
 * webhook 是「尽力而为」：投递失败绝不阻塞过滤主流程，也绝不重试轰炸。
 */

export const AUDIT_SOURCE = 'jev-x-filter';

export function createAuditor(options = {}) {
  const {
    webhookUrl = '',
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    limit = 500,
    version = '0.1.0',
    onError = null,
  } = options;

  let url = String(webhookUrl ?? '').trim();
  const buffer = [];
  let seq = 0;

  function record(event) {
    seq += 1;
    return {
      id: `${seq}`,
      ts: now(),
      iso: new Date(now()).toISOString(),
      source: AUDIT_SOURCE,
      version,
      ...event,
    };
  }

  return {
    setWebhookUrl(next) {
      url = String(next ?? '').trim();
    },
    getWebhookUrl() {
      return url;
    },
    list() {
      return buffer.slice();
    },
    clear() {
      buffer.length = 0;
      seq = 0;
    },
    /**
     * 记录一条事件；返回投递结果，调用方可以忽略。
     * @param {object} event
     */
    async emit(event) {
      const entry = record(event);
      buffer.push(entry);
      if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
      if (!url || typeof fetchImpl !== 'function') return { delivered: false, entry, error: url ? 'no_fetch' : 'no_webhook' };
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(entry),
          keepalive: true,
        });
        return { delivered: res.ok, entry, status: res.status };
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          /* 观测不能影响主流程 */
        }
        return { delivered: false, entry, error: String(error?.message ?? error) };
      }
    },
  };
}
