/**
 * 可选的视觉模型适配器（默认关闭）。
 *
 * 因为 Jev 只能读文本，纯图片黄推只能靠本地启发式（media.js）或外部视觉模型。
 * 这里实现一个最小、可替换的 OpenAI 兼容 `/chat/completions` 适配器：
 * 任何支持 `image_url` 多模态输入的服务都能接（OpenAI、OpenRouter、Gemini 兼容层、
 * 自建 vLLM/ollama 网关…）。
 *
 * 隐私提示：启用后，图片 URL（而不是图片本体）会被发送给该服务；这是用户显式
 * 配置的可选项，默认关闭。返回同样要求「概率 + 置信度」，缺字段一律视为无效，
 * 不猜测、不修补。
 */

export const VISION_SYSTEM_PROMPT = [
  'You are an image moderation classifier for a social media timeline filter.',
  'You never converse. You answer with exactly one JSON object and nothing else.',
  'Schema: {"adult": boolean, "confidence": number between 0 and 1, "reason": string (max 120 chars)}',
  'Set "adult" to true only for clearly pornographic or sexually explicit imagery.',
  'Swimwear, lingerie, artistic nudity, gym photos, selfies, medical images and close-ups of',
  'faces, food, pets or skin must be false. When unsure, set adult=false and lower the confidence.',
  'confidence is your calibrated certainty in the "adult" label.',
].join('\n');

export function visionReady(cfg) {
  return Boolean(cfg?.visionEnabled && cfg.visionBaseURL && cfg.visionModel);
}

function extractJsonObject(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试从围栏或大括号里抠 JSON */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {string} imageUrl 可公开访问的图片地址
 * @param {object} cfg settings.media
 * @param {object} deps { fetchImpl }
 * @returns {Promise<{ok:boolean, adultProb?:number, confidence?:number, reason?:string, error?:string}>}
 */
export async function classifyImageWithVision(imageUrl, cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!visionReady(cfg)) return { ok: false, error: 'vision_disabled' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.visionTimeoutMs ?? 15000);
  try {
    const res = await fetchImpl(`${cfg.visionBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.visionApiKey ? { authorization: `Bearer ${cfg.visionApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.visionModel,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Classify this image.' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
      : content;
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed.adult !== 'boolean') return { ok: false, error: 'invalid_answer' };
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, error: 'invalid_confidence' };
    return {
      ok: true,
      adultProb: parsed.adult ? Math.max(confidence, 0.5) : Math.min(1 - confidence, 0.5),
      confidence,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 160) : '',
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
