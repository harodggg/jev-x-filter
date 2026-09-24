# jev-systemone

Typed TypeScript client for **Jev System One models** (TypeSafe). One `JevClient`
works with TypeSafe direct and any System One-compatible gateway.

> Jev is **not a chat model**. You send `state` + typed `questions`
> (**Choice** / **Score** / **Noul**) and get typed `answers` back.
> Calling it via `/chat/completions` returns `Internal server error` — use
> `POST {baseURL}/v1/systemone` (this package does that for you).

## Install

```bash
npm i jev-systemone
```

Requires Node >= 20 (uses global `fetch`).

## 30-second start

```ts
import { choice, score, noul, createTypeSafeClient } from "jev-systemone";

const jev = createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY });

const res = await jev.systemOne({
  state: "My Stripe payouts failed 3 days in a row. Help ASAP.",
  questions: {
    department: choice("Which team should handle this", {
      billing: "Payment or subscription issues",
      technical: "Bugs or integration problems",
      sales: "Pricing or account questions",
    }),
    frustration: score("How frustrated the customer appears", [
      "Calm, just stating facts",
      "Frustrated but civil",
      "Very angry, strong language",
    ]),
    is_urgent: noul("The message conveys urgency or time-sensitivity"),
  },
});

console.log(res.answers.department.choice);        // "billing"
console.log(res.answers.department.probabilities); // { billing: 0.66, ... }
console.log(res.answers.frustration.score);        // e.g. 1.0
console.log(res.answers.is_urgent.noul);           // e.g. 0.99
```

No key at hand? Point the client at a gateway that serves the free tier:

```ts
import { createZenClient } from "jev-systemone";
const jev = createZenClient(); // free tier works without a key
```

## Choosing a provider (presets)

Pick at construction. Explicit values always win over the preset.

| Preset | Base URL | Default model | Key? |
|---|---|---|---|
| `typesafe` (official) | `https://api.typesafe.ai` | `jev-latest` | required |
| `zen` | `https://opencode.ai/zen` | `jev-1.13-free` | optional (free tier works keyless) |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | required |
| `vercel` | `https://ai-gateway.vercel.sh` | `typesafe-ai/jev` | required |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts` | `typesafe/jev` | required |
| `custom` | whatever you pass | whatever you pass | as needed |

```ts
import {
  JevClient,
  createZenClient,
  createTypeSafeClient,
  createOpenRouterClient,
  createCustomClient,
} from "jev-systemone";

// Official TypeSafe (needs key)
const official = createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY });

// Same thing via generic constructor + preset
const official2 = new JevClient({ preset: "typesafe", apiKey: process.env.TYPESAFE_API_KEY });

// Fully custom: any URL + token + model + path
const mine = createCustomClient({
  baseURL: "https://proxy.mycompany.local/jev",
  apiKey: "my-token",
  defaultModel: "jev-1.13",
  path: "/v1/systemone", // override if your gateway mounts it elsewhere
  defaultHeaders: { "X-Team": "support" },
});

// Per-call model override still works
await official.systemOne({
  state: "…",
  questions: { q: noul("Urgent?") },
  model: "jev-1.13",
});
```

Env vars (all optional, explicit config wins):
`TYPESAFE_API_KEY`, `OPENCODE_ZEN_API_KEY`, `JEV_API_KEY`,
`TYPESAFE_BASE_URL` / `JEV_BASE_URL`, `JEV_PATH`, `JEV_DEFAULT_MODEL`.

## The three question types

Only three exist — that is the whole type system.

| Type | Shape | Returns | Use for |
|---|---|---|---|
| **Choice** | one of N unordered options (max 255) | `choice`, `probabilities` (sum 1), `confidence` | routing, classification, intent |
| **Score** | position on 2–10 ordered levels | `score` (weighted mean, may be fractional), `legend`, `probabilities`, `confidence` | severity, frustration, quality |
| **Noul** | yes/no | `noul` 0–1 (probability of yes; **no** separate confidence) | flags, checks, gates |

```ts
import { choice, score, noul } from "jev-systemone";

choice("Which team?", { billing: "Payments", technical: "Bugs", other: null });
score("How severe?", ["Cosmetic", "Broken with workaround", "Blocking, no workaround"]);
noul("Does this request a refund?");
noul("Urgent?", { true: "time-sensitive", false: "no urgency" });
```

Rules that matter:
- **Choice**: add `"other"` / `"none_of_the_above"` when the list may not cover input.
- **Score**: describe *situations*, not degrees (`"Broken, workaround exists"` beats `"Medium"`). `score` is `Σ level × probability`, e.g. `0×0 + 1×0.7 + 2×0.3 = 1.3`. Same score can hide different distributions — read `probabilities` too.
- **Noul**: `0.5` means *uncertain*, not *medium*. For graded skill use Score; threshold Noul in code (`> 0.7`).
- Question ids are yours only — they are not sent to the model. Write the full question in `instructions`.
- All questions in one call see the same `state`, run in parallel, and are independent. Batch freely (speculative questions are cheap).

## Confidence (Choice/Score only)

`confidence` 0–1 is derived from how peaked `probabilities` is. Flat = unsure.

```ts
import { confidenceBand, isConfident, normalizeScore } from "jev-systemone";

if (!isConfident(res.answers.department, 0.5)) return sendToHuman(ticket);
const band = confidenceBand(res.answers.frustration.confidence); // high|medium|low
const priority = normalizeScore(res.answers.frustration.score, 3); // 0..1 (score / (levels-1))
```

Pattern: high → act, medium → confirm/flag, low → route to human. Scale thresholds with risk.

## API reference

- `new JevClient(config)` — `config: { preset?, apiKey?, baseURL?, path?, defaultModel?, timeout?, retry?, defaultHeaders?, logLevel?, logger?, fetch?, dangerouslyAllowBrowser? }`. Exposes `.baseURL`, `.path`, `.preset`, `.defaultModel`.
- `client.systemOne({ state, questions, model? }, options?)` — validates client-side, POSTs, retries, returns `{ model, answers, usage, cost? }`. `answers` types follow your `questions` (`ResultFor`).
- `client.listModels()` — `GET /v1/models`.
- Factories: `choice(instructions, criteria)`, `score(instructions, criteria)`, `noul(instructions, criteria?)` + `create*Client` presets above.
- Errors (all extend `JevError`): `AuthenticationError` (401), `ValidationError` (422 + client misuse), `RateLimitError` (429), `OverloadedError` (529), `ConnectionError`, `TimeoutError`, `AbortError`. Use `errorFromResponse(res)` for manual mapping.
- Retry: `{ maxRetries: 2, backoffInitialMs: 500, backoffMaxMs: 5000, backoffJitter: 0.25, httpStatuses: 408/429/5xx/529, respectRetryAfter, apiConnectionError, apiTimeoutError }`. Per-call `options.retry` / `options.timeout` / `options.signal` / `options.headers` override.

## Limits & jagged edges

- Text-only state (string/object/array), ~32k token budget shared by state + questions. Choice ≤ 255 options, Score 2–10 levels.
- Strongest in English; weak on math, dates, hex/RGB proximity, deep indirection — do arithmetic in code, let Jev do judgment.
- Calibration ≠ correctness: use confidence gates, don't auto-act on low confidence.

## Developing

```bash
npm install
npm test          # mocked unit tests (TDD: questions, errors, retry, helpers, client, presets)
npm run test:live # hits a live endpoint (JEV_LIVE=1)
npm run build     # tsc -> dist/ (+ .d.ts)
npm run typecheck
```

Layout: `src/types.ts` (all public types), `src/helpers.ts` (factories + confidence utils),
`src/validation.ts`, `src/errors.ts`, `src/retry.ts`, `src/client.ts`, `src/index.ts` (barrel).
Tests in `tests/`, example in `examples/basic.ts`.
