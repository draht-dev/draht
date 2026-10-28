# Radius Gateway at radius.draht.dev — Planning Spec

- **Date:** 2026-10-01
- **Status:** draft for owner review. Not adopted into `ROADMAP.md`; phases are labelled `RG-0`..`RG-9` so they can be renumbered on adoption.
- **Decision of record (Oskar, 2026-10-01):** bug-report intake ships now as v1 (in flight in `packages/infra` and `packages/coding-agent` on the clone's `main`); the full gateway goes into planning. This document is that plan.
- **Sources read (read-only):**
  - Clone `/home/nix/draht-upstream-sync`, branch `main` @ `c7ceb957c` (draht synced to pi v0.99.2), **plus** the uncommitted bug-report v1 working-tree edits seen 2026-10-01 (`packages/coding-agent/src/core/radius.ts`, `bug-report-upload.ts`, `modes/interactive/bug-report.ts`, new `test/radius-gateway.test.ts`, docs).
  - Upstream intent: `git log pi/main --grep -i radius` — `961fa6c14` (add Radius gateway support), `a9f5b1c12` (route Radius OAuth through gateway), `4d38031fb` (ship Radius model catalog), `1d0d110ab` / `686f3487f` (relay and artifacts, not carried by draht).
  - draht-mono @ `147e78929` for planning conventions (`PROJECT.md`, `ROADMAP.md`, `STATE.md`, `PRODUCT-MAP.md`, `RELEASE-EVIDENCE.md`).
- **Citation rule:** every `file:line` is in the clone unless prefixed `draht-mono:`. Paths are relative to the repo root. Lines in files under active edit by the bug-report agent are marked "(working tree)".
- **Evidence classes:** as defined in draht-mono `.planning/RELEASE-EVIDENCE.md` (E0 unit … E4 soak). Faux providers cap evidence at E1.

---

## 1. Goal and non-goals

### Goal

When this is done, a draht user can run `/login`, pick Radius, sign in at `radius.draht.dev`, and get a working, metered, prepaid multi-model catalog without holding any upstream provider key. No draht user's prompt, token or key reaches `radius.pi.dev` unless they configure that explicitly.

The outcomes behind the request:
1. **Control of the default credential sink.** Today the built-in `radius` provider sends draht users' sign-in, refresh tokens and prompts to `https://radius.pi.dev` (`packages/ai/src/providers/radius-config.ts:4`). draht should own that endpoint.
2. **One sign-in for many models** for draht's audience.
3. **Cost recovery and revenue.** The gateway pays upstream providers, so it has to meter and bill.

### Non-goals (v1 of the full gateway)

- **Session relays** (`/v1/session-relays/:id/connect`, upstream `packages/coding-agent/src/experimental/radius-relay.ts:619`) and **share artifacts** (`/v1/artifacts`, upstream `session-share.ts:119`). draht removed the experimental CLI orphans in `b19045352`. By owner rule `/share` stays gist-only (`packages/coding-agent/src/modes/interactive/session-share.ts:55-58`).
- **No server-side session storage, history or prompt logging, and no training on user data.** This is a hard invariant (§4.8), not something deferred.
- **Gateway message rewriting.** The client understands a `rewrite` impact field (`packages/ai/src/api/pi-messages.ts:43-51,169-178`), but v1 never emits one.
- **Image and classifier model types.** `radius.models.ts:16-24` exports them, but the shipped catalog contains only chat models.
- **Multi-upstream fallback per model id.** In v1 each public model id maps to exactly one upstream (§4.5, R7).
- Team or organisation accounts, invoiced or post-paid billing, and enterprise SSO.
- **Migrating radius.pi.dev accounts, balances or credentials** (§6.4). draht has no relationship with pi.dev's backend.
- **Replacing bug-report intake v1.** It is the first tenant of the same domain, and the gateway extends it.

---

## 2. Findings from the code that the plan depends on

| # | Finding | Evidence |
|---|---|---|
| F1 | **`DRAHT_RADIUS_GATEWAY` does not affect the model provider.** `getRadiusGatewayUrl()` has no caller in `src/`; only the new test calls it. The built-in provider is registered as `radiusProvider()` with no options and so uses the hard default. The working-tree docs describe the variable as being "for Radius relay connections", which draht removed. Today the only working custom-gateway path is a `models.json` provider with `"oauth":"radius"` under a different provider id. | `packages/coding-agent/src/core/radius.ts:7-9` (working tree); `packages/coding-agent/test/radius-gateway.test.ts:30-39`; `packages/ai/src/providers/all.ts:169`; `packages/ai/src/providers/radius.ts:25`; `packages/coding-agent/docs/environment-variables.md` (working tree); `packages/coding-agent/src/core/model-runtime.ts:262-277`; `packages/coding-agent/test/radius.test.ts:127-157` |
| F2 | **Credentials are keyed by provider id, not by gateway origin.** The stored credential has no origin field. Refresh POSTs the refresh token to whichever gateway the provider is currently configured with. The access token is also sent as Bearer to `/v1/config`. If the `radius` provider is pointed at a new origin, every stored secret goes to that origin. | `packages/ai/src/auth/types.ts:24-34`; `packages/ai/src/models.ts:608-625`; `packages/ai/src/auth/oauth/radius.ts:304-315`; `packages/ai/src/providers/radius.ts:82-83` |
| F3 | **Persisted catalogs carry absolute `baseUrl`s, and `pi-messages` posts to `model.baseUrl`.** Stored and legacy catalogs are restored verbatim. All 28 shipped baseline models point at `https://radius.pi.dev/v1`, and the baseline is applied only when the gateway equals the default. If the default is flipped without regenerating `radius.json` and filtering stored models, draht-issued tokens go to radius.pi.dev. | `packages/ai/src/providers/radius.ts:26-29,50-79`; `packages/ai/src/api/pi-messages.ts:370`; `packages/ai/src/providers/data/radius.json` |
| F4 | **Bug-report v1 (in flight) sends the Radius credential to a different origin.** `upload()` resolves the `radius` provider's credential, which today is issued by radius.pi.dev or comes from `RADIUS_API_KEY`. The uploader sends it as Bearer to `https://radius.draht.dev`. **Until the Radius provider's gateway is draht's, this gives draht's intake the user's pi.dev token.** It must be fixed before v1 ships (RG-1a). | `packages/coding-agent/src/modes/interactive/bug-report.ts:182-188` (working tree); `packages/coding-agent/src/core/bug-report-upload.ts:20-26` (working tree); `packages/coding-agent/src/core/radius.ts:12` (working tree) |
| F5 | **The server, not the client, prices usage.** The client copies `usage`, including `cost`, from the terminal event unchanged. The cost a user sees is whatever the gateway reports. | `packages/ai/src/api/pi-messages.ts:195-217` |
| F6 | **The client tolerates SSE comment heartbeats.** The parser takes the first `data:` line of each block and skips blocks without one. | `packages/ai/src/api/pi-messages.ts:313-321` |
| F7 | **Unauthenticated `/v1/config` is the public catalog.** The model generator fetches it without credentials. | `packages/ai/scripts/generate-models.ts:1329-1342,2756-2761` |
| F8 | **Static API keys are first-class.** The `RADIUS_API_KEY` env var is sent exactly like an OAuth access token. | `packages/ai/src/providers/radius.ts:37,82`; `packages/ai/src/env-api-keys.ts:104` |
| F9 | **No deploy pipeline exists.** No workflow runs `sst deploy`. `packages/infra/README.md` says deploys are CI-managed. PRODUCT-MAP classifies `@draht/infra` as **Example**, and promotion requires auth, owners, deploy/rollback/observability and E2 readback. | `.github/workflows/*`; `packages/infra/README.md`; draht-mono `.planning/PRODUCT-MAP.md` ("Infra decision") |
| F10 | **Client paths are absolute.** Every client URL is built as `new URL("/v1/…", gateway)`, so any path on the gateway URL is discarded and the gateway must serve from its origin root. URLs are normalised to `https://` with no trailing slash. A `models.json` gateway has a trailing `/v1` stripped. | `packages/ai/src/auth/oauth/radius.ts:42,101,192`; `packages/ai/src/providers/radius-config.ts:52-55,87`; `packages/coding-agent/src/core/model-runtime.ts:273` |
| F11 | **Client retry and compaction decisions are regex matches on the error text.** The gateway's error wording is therefore part of the contract (§3.7). | `packages/ai/src/utils/retry.ts:7-27,30-75,246-251`; `packages/ai/src/utils/overflow.ts:37-62,76-80`; `packages/coding-agent/src/core/agent-session.ts:3750-3753` |
| F12 | **Request size is unbounded on the client.** `inputLimits.maxRequestBytes` is declared but nothing enforces it. Images may be up to 4,718,592 base64 bytes each, and context windows go up to 1,048,576 tokens. | `packages/ai/src/types.ts:1090-1094`; `packages/coding-agent/src/core/model-config.ts:150`; `radius.json` (`inputLimits.images.resize.maxBytes`, `contextWindow`) |

---

## 3. Wire contract

This is derived from the client code. The draht client is the only consumer, so where the client is silent the gateway picks the behaviour and §3 records it.

### 3.0 Conventions

- **`G`** is the gateway origin (`https://radius.draht.dev`). **`B`** is the data-plane base, which is the `baseUrl` returned by `/v1/config`. The client stamps that `baseUrl` on every model (`radius-config.ts:61-68`), so any per-model `baseUrl` is overwritten.
- **There are four error dialects.** Each one is fixed by its client code:

  | Surface | Error body | Client reader |
  |---|---|---|
  | `/v1/oauth*` | `{"error": string, "error_description"?: string}` (RFC 6749); a non-JSON body becomes the description | `radius.ts:76-92` |
  | `/v1/config` | any non-2xx; the body text is truncated to 512 chars and shown | `radius-config.ts:75-78,88-92` |
  | `B/messages` | `{"error": {"message": string, "code"?: string, "details"?: any}}` | `pi-messages.ts:89-156` |
  | `/v1/bug-reports` | `{"ok": false, "error"?: string, "description"?: string}` | `bug-report-upload.ts:27-37` (working tree) |

  The gateway uses the `messages` dialect for `/v1/config` as well, so that at least two surfaces agree.
- **Every response carries an `x-radius-request-id` header.** The client records response headers through `onResponse` (`pi-messages.ts:404`).

### 3.1 `GET G/v1/oauth` — browser-flow discovery

- **Request:** `accept: application/json`, no auth (`radius.ts:41-45`). It is called only for browser sign-in (`radius.ts:297-299`).
- **200 response:** `{"authorizationEndpoint": "https://radius.draht.dev/oauth/authorize"}`. The key is camelCase and is the only field read (`radius.ts:53-57`). A non-2xx response aborts login with the status and body (`radius.ts:47-51`).

### 3.2 Browser authorization — `GET <authorizationEndpoint>` and the loopback callback

- **Query parameters** sent by the client (`radius.ts:141-151`):
  - `response_type=code`
  - `client_id=pi-gateway`
  - `redirect_uri=http://127.0.0.1:1456/oauth/callback` (fixed host, port and path: `radius.ts:18-21`)
  - `scope=gateway offline_access`
  - `code_challenge=<S256>` and `code_challenge_method=S256`
  - `handoff=url`
  - `state=<uuid>`
- **Gateway rules:**
  - Match `redirect_uri` exactly against the registered value for `pi-gateway`.
  - Require S256 and reject `plain`.
  - Accept and ignore `handoff`. It is an upstream-specific hint; v1 always redirects.
- **On approval:** `302` to `redirect_uri?code=<code>&state=<state>`.
- **On denial:** `302` to `redirect_uri?error=access_denied&error_description=<text>&state=<state>`.
- **What the client checks:** `state`, then `error`, then `code`. It answers `400` on a missing code (`packages/ai/src/auth/oauth/callback-server.ts:85-107`).
- **Codes** are single-use, have a TTL of 60 s, and are bound to `client_id`, `redirect_uri` and `code_challenge`.

### 3.3 `POST G/v1/oauth/device` — RFC 8628 device authorization

- **Request:** `application/x-www-form-urlencoded` with `client_id=pi-gateway` and `scope=gateway offline_access` (`radius.ts:192-196`).
- **200 response:**
  - Required and non-empty: `device_code`, `user_code`, `verification_uri`, `expires_in`.
  - Optional: `interval`. The client defaults it to 5 s (`radius.ts:209-220`; `device-code.ts:7`).
- **What the client shows:** only `verification_uri` and `user_code`. It never reads `verification_uri_complete` (`radius.ts:225-231`), so the user always types the code. That matters for phishing resistance (§5 T7).
- **Gateway choices:**
  - `user_code` is 8 characters from `BCDFGHJKLMNPQRSTVWXZ`, shown as `XXXX-XXXX`.
  - `expires_in=600`, `interval=5`.
  - `verification_uri=https://radius.draht.dev/device`.

### 3.4 `POST G/v1/oauth/token` — three grants

**Request:** form-encoded with `accept: application/json` (`radius.ts:101-106`).

| Grant | Form fields | Client source |
|---|---|---|
| `authorization_code` | `client_id`, `redirect_uri`, `code`, `code_verifier` | `radius.ts:162-168` |
| `urn:ietf:params:oauth:grant-type:device_code` | `client_id`, `device_code` | `radius.ts:241-245` |
| `refresh_token` | `client_id`, `refresh_token` | `radius.ts:307-311` |

**200 response:**
- `{"access_token", "refresh_token", "expires_in" (seconds), "scope"?, "token_type": "Bearer"}`. `token_type` is not read (`radius.ts:118-131`).
- **`refresh_token` must be present in every successful response, including refresh.** The client stores `data.refresh_token` without checking it (`radius.ts:128`). If it were omitted, the credential would be written with `refresh: undefined` and the next refresh would break.
- The client subtracts 60 s of skew from expiry (`radius.ts:22,129`).

**400 errors and how the client reacts:**

| Error | Client behaviour |
|---|---|
| `authorization_pending` | keeps polling |
| `slow_down` | adds 5 s to its interval (`device-code.ts:9,76-80`); any `interval` in a `slow_down` body is ignored because `radius.ts:256` drops it |
| `expired_token` | "Device authorization expired." |
| `access_denied` | "Device authorization was denied." |
| anything else (`invalid_grant`, `invalid_client`, …) | aborts with `Radius OAuth token request failed: <error>: <description>` (`radius.ts:249-264`) |

A refresh failure surfaces as a `ModelsError` with code `oauth`. The stored credential is kept, and re-login fixes it (`packages/ai/src/models.ts` doc comment on `getAuth`).

### 3.5 `GET G/v1/config` — gateway config and model catalog

- **Request:** `accept: application/json`, plus `authorization: Bearer <access token | API key>` when a credential exists (`radius-config.ts:85-87`). The client calls it only on a network-allowed refresh (`providers/radius.ts:81-83`).
- **200 response:** `{"baseUrl": string, "models": RadiusGatewayModel[]}` (`radius-config.ts:6-20`).
  - **Required fields per model:** `id` and `name` (strings), `reasoning` (boolean), `input` (array), `cost` (object), `contextWindow` and `maxTokens` (numbers).
  - Invalid models are dropped silently (`radius-config.ts:26-50`).
  - The whole response is rejected if `baseUrl` is not a string or `models` is not an array (`radius-config.ts:44-46`).
- **Extra fields pass through by spread** (`radius-config.ts:48`) and become `Model` fields. The gateway uses:
  - `thinkingLevelMap`
  - `inputLimits` (`images.resize`, plus `maxRequestBytes`, which is informational only, F12)
  - `lab`
  - `enabled`
  - `type: "chat"`
- **`cost`** is `{input, output, cacheRead, cacheWrite, tiers?}` in $/Mtok (`types.ts:1063-1071`). It must equal the prices the meter charges (§4.4).
- **Semantics:**
  - No `authorization` header returns the public catalog (F7) with `Cache-Control: public, max-age=300`.
  - A valid credential returns the account catalog with `Cache-Control: private, no-store`.
  - An invalid or expired credential returns `401 {"error":{"message":"invalid or expired token","code":"unauthorized"}}`, not the public catalog, so that auth problems show up.
- **`baseUrl`** is `https://inference.radius.draht.dev/v1` (§4.2).

### 3.6 `POST B/messages` — the pi-messages stream

**Request** (`pi-messages.ts:370-402`):
- **URL:** `${baseUrl}/messages` with trailing slashes stripped. The client adds `?debug=1` when `options.debug` is set.
- **Headers:** `authorization: Bearer …`, `accept: text/event-stream`, `content-type: application/json`, plus any model/provider headers.
- **Body:**
  ```json
  { "model": "<catalog id>",
    "context": { "messages": [ /* Message[] */ ] },
    "options": { "temperature"?: number, "maxTokens"?: number,
                 "reasoning"?: "minimal"|"low"|"medium"|"high"|"xhigh"|"max",
                 "cacheRetention"?: "none"|"short"|"long",
                 "sessionId"?: string,
                 "toolChoice"?: "auto"|"none"|"required"|{"type":"function","function":{"name":string}} } }
  ```
- **`context`** is a `TranscriptContext` (`types.ts:746-749`):
  - The leading `system` message carries the prompt, named `sections` and `toolsAdded`/`toolsRemoved` (`types.ts:520-538`).
  - Images are inline base64 (`types.ts:411-415`).
  - `cacheRetention` is the caller's value, or `long` when `DRAHT_CACHE_RETENTION=long` (`pi-messages.ts:347-353`).
- **Extensions can rewrite the body** through `onPayload` (`pi-messages.ts:387-390`). The gateway therefore validates strictly and never trusts the shape.

**Success response:** `200`, `content-type: text/event-stream`.
- **Framing:** blocks separated by a blank line, each with one `data: <JSON PiMessagesEvent>` line. The reader normalises CRLF, splits on `\n\n`, takes the first `data:` line and ignores `[DONE]` (`pi-messages.ts:276-321`).
- **Event grammar** (`pi-messages.ts:54-87`, consumed at `180-274`):
  ```
  start
  ( text_start(i)     text_delta(i)*     text_end(i, content, contentSignature?)
  | thinking_start(i) thinking_delta(i)* thinking_end(i, content, contentSignature?, redacted?)
  | toolcall_start(i, id, toolName) toolcall_delta(i, jsonFragment)* toolcall_end(i, toolCall) )*
  ( done(reason ∈ stop|length|toolUse, usage, responseId?, providerThinkingLevel?)
  | error(reason ∈ aborted|error, usage, errorMessage?, responseId?, providerThinkingLevel?) )
  ```
- **Event rules:**
  - `toolcall_start` must carry `id` and `toolName` (`pi-messages.ts:68`).
  - `toolCall` is `{type:"toolCall", id, name, arguments, thoughtSignature?}` (`types.ts:417-425`).
  - `usage` is the full `Usage` object with `cost` (`types.ts:427-448`).
  - `done.reason` is never `deferred`. The client type excludes it, although `AssistantMessageEvent` allows it (`types.ts:778-782`).
- **Termination:** the client stops reading after the terminal event (`pi-messages.ts:418-420`). The server closes the stream after the terminal event. Ending without one produces the client error `<provider> stream ended without a terminal event` (`pi-messages.ts:423`).
- **Heartbeat:** the server writes `: ping\n\n` every 15 s, both before the first event and between events (F6).
- **Pre-stream errors:** non-2xx with the `messages` error dialect. The client renders `${status} ${statusText}: ${message} (${code})` (`pi-messages.ts:125-135`) and attaches a diagnostic (`pi-messages.ts:137-156`).

### 3.7 Error → client behaviour (normative)

Client classification is regex-based (F11), so the gateway's message text is part of the contract.

| Condition | HTTP | `code` | `message` must contain | Client effect |
|---|---|---|---|---|
| bad, expired or revoked token | 401 | `unauthorized` | `invalid or expired token` | not retryable; user re-logs in |
| credit balance exhausted (pre-stream) | 402 | `insufficient_quota` | `insufficient_quota` | **non-retryable** (`retry.ts:7-27` is checked first, `retry.ts:249`) |
| account or API-key spend cap reached | 429 | `quota_exceeded` | `quota exceeded` | **non-retryable** (the 429 is overridden by the non-retryable list) |
| transient rate limit | 429 + `Retry-After` | `rate_limited` | `rate limit exceeded` | retryable (`retry.ts:34-36`); `rate limit` also prevents overflow misclassification (`overflow.ts:76-80`) |
| context exceeds the model window | 400 | `context_length_exceeded` | `context_length_exceeded` | overflow, so compaction rather than retry (`overflow.ts:60`; `agent-session.ts:3750-3753`) |
| body exceeds the gateway byte cap | 413 | `request_too_large` | `request_too_large` | overflow, so compaction (`overflow.ts:40`) |
| unknown or disabled model | 404 | `model_not_found` | `model not found` | not retryable |
| upstream 5xx or overload before the first token | 503 | `upstream_unavailable` | `service unavailable` | retryable |
| kill switch engaged | 503 | `service_unavailable` | `service unavailable` | retryable with backoff |
| upstream failure mid-stream | 200 then SSE `error` | — | scrubbed upstream text prefixed `upstream error: ` | classified on `errorMessage` by the same regexes |
| hold exhausted mid-stream (§4.6) | 200 then SSE `error` | — | `insufficient_quota: credit balance exhausted` | non-retryable |
| client abort | — | — | — | server aborts upstream and nothing is delivered |

### 3.8 `POST G/v1/bug-reports` (v1, in flight; recorded here so the gateway stays compatible)

- **Request:** multipart with `report.json`, `diagnostics.json`, and optionally `session.jsonl` and `summary.md` (`packages/coding-agent/src/core/bug-report.ts:252-272`). Bearer is optional.
- **Success:** 2xx `{"ok":true,"bug_report":{"id":string}}`.
- **Error:** `{"ok":false,"error","description"}` (`bug-report-upload.ts:21-37`, working tree).
- **Once accounts exist:** a valid token attributes the report to the account. An invalid token is ignored and the report is accepted anonymously with `"attributed": false` (D14).

### 3.9 Endpoints not called by draht

`/v1/session-relays/*` and `/v1/artifacts` are out of scope (§1).

---

## 4. Architecture on AWS / SST

### 4.1 Topology (region `eu-central-1`)

```
draht CLI ──HTTPS──► radius.draht.dev  (API Gateway HTTP API v2, custom domain via sst.aws.dns() / Route 53)
                      ├─ GET  /v1/oauth · POST /v1/oauth/device · POST /v1/oauth/token   → Lambda "oauth"
                      ├─ GET/POST /oauth/authorize · /device · /account · /auth/github/cb → Lambda "web"
                      ├─ GET  /v1/config                                                → Lambda "config"
                      ├─ POST /v1/bug-reports                                           → Lambda (bug-report v1)
                      └─ POST /v1/billing/webhook                                       → Lambda "billing"
draht CLI ──HTTPS──► inference.radius.draht.dev  (ALB, ACM cert; optional AWS WAF)
                      └─ POST /v1/messages  → ECS Fargate service "inference" (Node 22, ARM64)
                                               └─► upstream APIs (keys from SST secrets / SSM SecureString)
shared: DynamoDB table "Radius" (TTL) · SSM parameter kill switch · CloudWatch logs/metrics/alarms
```

The control plane and data plane are split by **using the protocol's own `baseUrl` indirection**: `/v1/config` advertises `https://inference.radius.draht.dev/v1`. The control plane keeps the `ApiGatewayV2` pattern already used in `packages/infra/sst.config.ts:34-49`. The data plane runs where streaming has no 30 s or 15 min ceiling.

### 4.2 Data-plane transport (decision D1)

| Option | Streaming | Duration cap | Request body cap | Client disconnect seen by server | Fixed cost | Verdict |
|---|---|---|---|---|---|---|
| A. API GW HTTP API v2 + Lambda | **no**. The SST `Function.streaming` docstring says "not supported with API Gateway HTTP API (V2)" | 30 s integration | — | — | none | rejected |
| B. API GW REST v1 + Lambda (`responseTransferMode: STREAM`, SST `apigatewayv1-lambda-route.ts:109-114`) | yes | Lambda 15 min | Lambda 6 MB request payload | unreliable | none | rejected: both caps reachable |
| C. Lambda Function URL `RESPONSE_STREAM` (SST `function.ts` `invokeMode`) + CloudFront for the custom domain | yes | 15 min | 6 MB | unreliable | none | fallback if RG-0 data allows |
| **D. ECS Fargate behind ALB** (`sst.aws.Cluster` + `Service` with `loadBalancer`) | yes (plain HTTP chunked) | none. ALB idle timeout is configurable and heartbeats keep it alive | no practical ALB body cap at this scale; the gateway enforces its own (32 MB) | yes: Node `request.on("close")` triggers upstream `AbortSignal` | 1 task 24/7 + ALB. Avoid a NAT gateway by using public subnets with a public IP, or SST `Vpc` `nat: "ec2"` | **recommended** |

**Why the Lambda caps are reachable, not theoretical:**
- **Request size:** the shipped catalog advertises `contextWindow` up to 1,048,576 and `maxTokens` up to 131,072 (`radius.json`: `balanced`, `kimi-k3`; Claude models have 128,000). Serialised text runs about 4 bytes per token, so a context near 1M tokens is about 4 MB *before* images. One image may add up to 4.7 MB (F12).
- **Duration:** 128k output tokens at 30–80 tok/s takes 27–71 min.
- RG-0 measures the real distribution from local session files before D1 closes.

The SST docstrings quoted above are from the SST platform source vendored at `/srv/work/draht/platine/examples/reference-playbook/.sst/platform/src/components/aws/` (`function.ts:676-694`, `apigatewayv1-lambda-route.ts`). Assumption A2 covers whether `sst@4.2.1` installs the same platform.

### 4.3 OAuth authorization server and account model

**Build a small custom authorization server on Lambda; do not use Cognito or OpenAuth.**
- The client contract fixes the endpoint paths (`/v1/oauth/token`, `/v1/oauth/device`), a public `client_id` (`pi-gateway`, `radius.ts:25`) and the RFC 8628 device grant.
- Cognito has no device grant and generates its own client ids.
- SST's OpenAuth issuer (`sst.aws.Auth`) serves its own paths and has no device grant.
- **Identity** on the authorize and device pages is delegated (D2; GitHub OAuth recommended).

**Tokens:**
- Opaque, 256-bit random, with type prefixes for secret scanning and log scrubbing: `drt_at_` (access), `drt_rt_` (refresh), `drk_` (API key). Only the SHA-256 is stored.
- **Access tokens:** TTL 3600 s. The data plane caches the lookup for 30 s, and negative results for 5 s.
- **Refresh tokens:** rotating and single-use, with 30-day idle and 90-day absolute expiry. Each belongs to a **family id**. Presenting an already-rotated refresh token revokes the whole family and every access token it issued.
- **API keys** (for `RADIUS_API_KEY` users, F8): created on `/account`, named, shown once, revocable, with an optional per-key spend cap.

**Web pages:**
- Session cookie: `HttpOnly; Secure; SameSite=Lax`, 12 h.
- The consent POST carries a CSRF token.
- The device page needs a signed-in user to type the `user_code`. It shows the request time, coarse IP country and "draht CLI" before approval.

**DynamoDB single table `Radius`:** keys `pk`/`sk`, GSI `gsi1pk`/`gsi1sk`, TTL attribute `expiresAt`.

| Item | pk | sk | Attributes |
|---|---|---|---|
| Account | `ACCOUNT#<id>` | `PROFILE` | email, githubId, status `active\|suspended\|closed`, createdAt, limitsTier, admin |
| Balance | `ACCOUNT#<id>` | `BALANCE` | creditMicroUsd (int), reservedMicroUsd (int), monthlyCapMicroUsd, version |
| Identity link | `IDENTITY#github#<ghId>` | `ACCOUNT` | accountId |
| Token | `TOKEN#<sha256>` | `META` | accountId, kind `access\|refresh\|apikey`, familyId, scope, expiresAt, revoked, name, spendCapMicroUsd |
| Token family (= device) | `FAMILY#<id>` | `META` | accountId, revoked, createdAt, lastUsedAt, uaFamily |
| Auth code | `AUTHCODE#<sha256>` | `META` | accountId, challenge, redirectUri, expiresAt (+60 s) |
| Device grant | `DEVICE#<sha256(device_code)>` | `META` | userCodeHash, status `pending\|approved\|denied`, accountId, lastPollAt, expiresAt (+600 s) |
| User code index | `USERCODE#<code>` | `META` | deviceKey, expiresAt |
| Usage record | `ACCOUNT#<id>` | `USAGE#<iso>#<requestId>` | model, upstream, input, output, cacheRead, cacheWrite, costMicroUsd, stopReason, estimated, durationMs, expiresAt (+400 d) |
| Ledger | `ACCOUNT#<id>` | `LEDGER#<iso>#<id>` | kind `topup\|adjustment\|refund`, amountMicroUsd, paymentRef (no TTL) |
| Concurrency lease | `ACCOUNT#<id>` | `LEASE#<requestId>` | holdMicroUsd, expiresAt (+70 min) |
| Rate window | `LIMIT#<accountId\|ipHash>#<window>` | `COUNT` | n, expiresAt |

**Authorisation rule:** every read or write is keyed by the `accountId` resolved from the token, never by an id taken from the request.

### 4.4 `/v1/config` catalog

- **Source of truth:** a checked-in `packages/radius-gateway/catalog/catalog.json` maps each public model id to `{upstreamProvider, upstreamModelId, enabled, markup?}`.
  - A build step fills `name`, `contextWindow`, `maxTokens`, `input`, `reasoning`, `thinkingLevelMap` and upstream cost from `@draht/ai`'s generated catalogs.
  - User price = upstream cost × (1 + markup), rounded up to 3 significant digits (D4).
- **Aliases `balanced`, `cheap` and `precise` are kept,** because `defaultModelPerProvider.radius = "balanced"` (`packages/coding-agent/src/core/model-resolver.ts:21`).
- **Public vs account catalog:** the public catalog is served from the bundled file with no DB read. The account catalog filters by account status and tier.
- **One pricing module** produces both `/v1/config` `cost` and the meter's charge. A test asserts they are equal for every model (RG-4).

### 4.5 Inference proxy (Fargate)

Per request:

1. **Authenticate.** Hash the Bearer token, look up the `TOKEN` item (LRU cache), and reject revoked tokens and suspended accounts with 401.
2. **Validate the body** against a TypeBox allowlist schema of §3.6:
   - Unknown top-level and option fields are dropped.
   - Caps: 32 MB body, 2,000 messages, per-image `maxBytes` from the catalog.
   - **Request headers other than `authorization`, `content-type` and `accept` are ignored.**
3. **Resolve the model only from the catalog.** The client never supplies an upstream URL, headers or model object (§5 T4a).
4. **Admit:** kill switch, rate limits, concurrency lease and credit hold (§4.6, §4.7).
5. **Call the upstream** through `@draht/ai`'s provider `streamSimple`, using the server-held key in `options.apiKey`. Adapters already exist for every v1 candidate: `packages/ai/src/providers/{anthropic,openai,xai,fireworks,baseten,deepseek,zai,moonshotai}.ts`.
   - The `context` is passed through as already-normalised `TranscriptContext`. `normalizeContext` only prepends a system message when `systemPrompt`/`tools` are given (`packages/ai/src/utils/transcript.ts:30-34`).
   - `sessionId` → `sha256(accountId + ":" + sessionId)`.
   - `reasoning` is clamped to the catalog `thinkingLevelMap`.
   - `maxTokens = min(requested ?? model.maxTokens, model.maxTokens)`.
   - The `AbortSignal` is tied to the client socket closing.
   - The hard maximum stream duration is 60 min.
6. **Map events** from `AssistantMessageEvent` (`types.ts:767-783`) to `PiMessagesEvent` (`pi-messages.ts:54-87`):
   - Drop `partial`.
   - `toolcall_start` takes `id` and `toolName` from `partial.content[contentIndex]`.
   - `text_end` and `thinking_end` take `contentSignature` from `textSignature`/`thinkingSignature`, plus `redacted`.
   - **Recompute `usage.cost` from the catalog price** (F5) before emitting `done` or `error`.
   - Never emit `deferred`. Catalog models must not need it.
7. **Heartbeat** `: ping` every 15 s.
8. **Scrub upstream error text** before it reaches `errorMessage` or the pre-stream `message` (§5 T4b). Keep the words that matter for classification (`overloaded`, `rate limit`, `context length`, …).
9. **Settle.** In one transaction, write the `USAGE` item and debit `BALANCE`. The transaction is idempotent on `requestId`. Then release the lease.

**Key custody:**
- Upstream keys are SST `sst.Secret` values (SSM SecureString), injected only into the inference task definition as ECS secrets.
- Only the inference task role can read them. They are never in `/v1/config`, responses or logs.
- Staging and production use separate keys.
- Per-upstream spend limits are set in each provider console. A runbook (RG-7) documents rotation and limits.

**Sticky upstream:** one upstream per model id keeps thinking-signature replay valid across turns (R7).

### 4.6 Metering and billing

- **Unit:** integer micro-USD everywhere.
- **Usage source:** the upstream adapter's usage on the terminal event, computed server-side. The client's numbers are never used.
- **Aborted streams** with no final upstream usage are charged estimated input (`serialisedContextBytes / 4` tokens) plus counted output (streamed characters / 4), flagged `estimated: true`.
- **Prepaid credit with holds:**
  - Admit only if `available = credit − reserved ≥ price(estInput, 1,024 output)`.
  - Hold `H = min(available, price(estInput, maxTokens))`.
  - While streaming, if running cost exceeds `H`, emit the SSE `error` `insufficient_quota: credit balance exhausted` and abort upstream.
  - Settle the actual cost (≤ H, except for slop within one 15 s tick) and release the rest.
  - The per-account concurrency cap (default 4) bounds the total held amount.
- **Spend caps:** a monthly cap per account (user-set) and an optional cap per API key. Hitting either gives `quota_exceeded`.
- **Payments (D3):** prepaid packs bought as one-time purchases. The webhook Lambda verifies the signature and idempotently writes `LEDGER` and increments `BALANCE` in one transaction.
- **User visibility:** `/account` shows balance, usage by day and model, device families (revoke) and API keys. No client UI exists for this, and none is needed for v1.

### 4.7 Abuse controls and rate limits

- **Unauthenticated OAuth endpoints:**
  - Device-code issuance: 10/min per IP.
  - Token polling faster than `interval` gets `slow_down`.
  - User-code entry: 5 failures per web session, then a 15 min lockout.
  - Global cap on pending device grants. TTL cleans up.
- **Per account:** 60 requests/min, 4 concurrent streams and a tokens/min ceiling per tier. New accounts get a lower tier for 7 days.
- **Edge protection:**
  - AWS WAF rate-based rules on the ALB.
  - Stage and route throttling on the HTTP API, because WAF does not attach to HTTP APIs (assumption A1).
- **Global circuit breaker:** the SSM parameter `/radius/<stage>/inference-enabled` is re-read every 30 s. A CloudWatch alarm on hourly upstream spend triggers a Lambda that sets it to `false`, after which the gateway answers `503 service_unavailable`.
- **Content abuse:** upstream usage policies flow down through the ToS (D6). Suspension is an IAM-gated admin script in v1; there is no admin web UI.

### 4.8 Logging and PII policy

- **Invariant:** request bodies, completions, tool arguments and results, images and system prompts are **never persisted or logged**, at any layer, in any stage.
- **Allowed per-request log fields:** `requestId`, opaque `accountId`, `familyId`, model, upstream, HTTP status, `stopReason`, token counts, `costMicroUsd`, TTFB, duration, `bytesIn` (a number), UA family, error code.
- **The `Authorization` header is never logged.**
- **Logger shape:** a single structured logger with a field allowlist. Raw `console.*` and logging of upstream error objects (which can echo request bodies) are banned. A biome rule or grep gate enforces this (RG-5).
- **IP addresses:** truncated (/24, /48) in logs. Full IPs exist only in memory for rate limiting.
- **Retention:** logs 30 days; `USAGE` 400 days; `LEDGER` for the tax-law period if draht is seller of record (D3).
- **`?debug=1`:** honoured only for accounts with `admin`. It adds `x-radius-upstream`. `x-radius-request-id` is always returned.
- **Upstream retention:** use zero-retention or opt-out terms where available (D7). The privacy policy discloses that prompts transit to the named upstreams, some of them in the US.

### 4.9 Observability

- **CloudWatch EMF metrics from Fargate:** requests, TTFB, duration, tokens, cost (by model and upstream), error codes, aborts, holds exhausted.
- **Alarms:**
  - 5xx rate > 5 % for 5 min
  - per-upstream error rate
  - p95 TTFB
  - hourly global spend (feeds the circuit breaker)
  - per-account spend spike
  - DynamoDB throttles
  - running task count < 1
- **Synthetic canary** every 5 min: unauthenticated `/v1/config`, plus an authenticated `/v1/messages` on the internal model `canary`, which routes to the `@draht/ai` faux provider. This proves the whole path with **no paid tokens**.

### 4.10 Code layout and SST resources

- **New private workspace `packages/radius-gateway`** (placement is D10):
  - `src/protocol/` — TypeBox schemas for every §3 surface; the single source for the server and contract tests
  - `src/oauth/`, `src/web/`, `src/catalog/`
  - `src/inference/` — event mapper, SSE writer, admission, scrubber
  - `src/metering/`
  - `src/store/` — a `Store` interface with DynamoDB and in-memory implementations
  - `src/server.ts` — Node http for Fargate
  - `src/lambda/*.ts` — thin adapters
  - `catalog/catalog.json`, `Dockerfile`
  - It depends on `@draht/ai`.
- **SST resources:**
  - `sst.aws.Dynamo("Radius", { ttl: "expiresAt", globalIndexes })`
  - `ApiGatewayV2` with `domain: { name: "radius.draht.dev", dns: sst.aws.dns() }` (pattern from `packages/landing/sst.config.ts:16-21`)
  - Lambda routes per §4.1
  - `sst.aws.Vpc`, `sst.aws.Cluster`, and `Service("Inference", { loadBalancer: { domain: "inference.radius.draht.dev", ports: [{ listen: "443/https", forward: "8080/http" }] }, scaling: { min: 1, max: 4 } })`
  - `sst.Secret` for each upstream key, the GitHub OAuth client and the payment webhook secret
  - SSM kill-switch parameter
- **Bug-report v1 reconciliation:** the full gateway reuses whatever API and domain v1 creates, not a second one (A5).
- **`sst deploy` never runs from development** (`packages/infra/sst.config.ts:11`). Deploys go through a CI workflow (RG-2).

---

## 5. Security analysis

| # | Threat | Vector | Mitigation | Residual | Proving test |
|---|---|---|---|---|---|
| T1 | **Token theft from the client disk** | `auth.json` under the agent dir is readable by any local process, including a prompt-injected agent's bash tool. draht's bash sandbox is E1-blocked (draht-mono `STATE.md` baseline). | 1 h access TTL; refresh rotation with reuse detection that revokes the family; device-family list with revoke on `/account`; per-key and monthly spend caps; spend-spike alarm. **Prepaid credit caps the loss at the balance.** | An attacker can use a stolen refresh token until the owner refreshes (reuse detected) or revokes | RG-3: reusing a rotated refresh token revokes the family, and the old access token then gets 401 |
| T2 | **Token exposure in transit or at the gateway** | Logs, DB dumps | TLS + HSTS; SHA-256-only storage; allowlist logger that never logs `Authorization`; prefixed tokens for secret scanning | — | RG-5 canary/log test also asserts no `drt_`/`drk_` substring in logs |
| T3 | **Cross-origin credential leakage by the draht client** | F2, F3, F4 | Origin-bound credentials; origin filter on persisted catalogs; `baseUrl` host must equal the gateway host or be its subdomain; bug-report token only sent to the same origin (RG-1) | Users who deliberately configure a hostile gateway | RG-1 tests a–e |
| T4 | **Prompt-injection-driven upstream key exfiltration** | (a) Client-controlled routing turned into SSRF with the server key; (b) upstream errors echoing key fragments (some providers echo a masked key prefix/suffix in auth errors); (c) debug output; (d) logs; (e) stack traces in responses | The gateway runs no tools and never interprets model output. (a) Allowlist body schema; the model comes from the catalog only; client headers are ignored. (b) Scrubber removes `sk-…`, `sk-ant-…`, `xai-…`, `fw_…`, `Bearer …` and any 20+ char key-like run next to `key`/`token`. (c) Debug for admins only. (d) Allowlist logger. (e) Generic 500 body with only a request id. | A new upstream key format not covered by the scrubber; mitigated by adding each provider's prefix when it joins the catalog | RG-5: a body with injected `baseUrl`, `headers` and an object `model` reaches the faux upstream with only server config. A faux upstream error containing `sk-ant-api03-…` reaches the client redacted. |
| T5 | **Multi-tenant isolation** | (a) IDOR; (b) **cross-tenant prompt-cache probing**: all tenants share one upstream org, so tenant B's request with tenant A's exact prefix reads A's cache (visible as `cacheRead` tokens or latency), revealing that A sent it; (c) session-affinity collisions; (d) in-process state | (a) The `accountId` always comes from the token. (b) **Per-account cache salt**: a short opaque per-account tag prepended to the first system text block, so cache prefixes never cross accounts (D8). (c) `sessionId` namespaced by account. (d) No per-tenant globals besides caches keyed by token hash. | (b) costs one extra cache prefix per account, which is the intended behaviour | RG-5: two accounts, same prompt; the second sees `cacheRead = 0` on the faux upstream, whose cache model is keyed by the prefix |
| T6 | **Cost exhaustion** | Stolen tokens; sybil sign-ups; maximum-size requests; streams that never end; parallelism; abort-retry loops; device-grant flooding; gateway double-billing bugs | Prepaid holds (§4.6); no free tier (D5); input estimate inside the hold; `maxTokens` clamp + hold-exceeded abort + 60 min hard cap; concurrency leases; upstream abort on disconnect; per-IP OAuth limits + TTL; idempotent settlement; global kill switch + provider-console spend limits | Slop within one heartbeat tick per stream; estimated charges on aborts | RG-6: concurrent-hold property test cannot overdraw; RG-7: kill-switch flip gives 503 within 30 s |
| T7 | **OAuth attacks** | Code interception on loopback; device-code phishing; open redirect; consent CSRF | Mandatory PKCE S256; no `verification_uri_complete`, so the user must type the code; the device page shows origin and time with a warning; exact `redirect_uri`; CSRF token + `SameSite` | Users who approve a code sent by an attacker despite the warning | RG-3 negative cases |
| T8 | **Supply chain** | Bundled `@draht/ai` and provider SDKs | Lockfile-pinned build; ECR scan on push; image digest pinned in the task definition | — | RG-2 deploy workflow pins the digest |
| T9 | **Payment webhook forgery or replay** | Forged or repeated events | Signature verification; idempotency on the payment event id | — | RG-6 replay test |
| T10 | **Data-plane DoS** | Connection floods | ALB + WAF rate rule; autoscaling `max` bounds cost; per-account concurrency | Availability loss under a large attack | RG-7 load smoke (staging, faux) |

---

## 6. Client changes in draht

### 6.1 Prerequisites, independent of the server (RG-1; ship first)

| Id | Change | Files | Test |
|---|---|---|---|
| a | **Fix F4 before bug-report v1 ships.** Attach the Radius token only when the Radius provider's gateway origin equals the bug-report gateway origin. Otherwise upload anonymously. | `packages/coding-agent/src/modes/interactive/bug-report.ts:182-188`, `packages/coding-agent/src/core/radius.ts` | new `packages/coding-agent/test/bug-report-upload-origin.test.ts`: with a fetch spy, the provider gateway `radius.pi.dev` + bug gateway `radius.draht.dev` produces a request with **no** `Authorization`; equal origins produce one with it |
| b | **Origin-bound Radius credentials.** `requestOAuthToken` stamps `gateway: <origin>` on the credential; `OAuthCredentials` allows extra keys (`auth/types.ts:24-29`). `refresh()` and `toAuth()` in `createRadiusOAuth` refuse, without sending anything, when the stamp is missing or differs, with the message `Radius sign-in was issued by <origin>; run /login radius`. **A missing stamp is treated as `https://radius.pi.dev`**, the only default so far. | `packages/ai/src/auth/oauth/radius.ts:94-132,304-319`; `packages/ai/src/providers/radius.ts:82` | new cases in `packages/ai/test/radius-oauth.test.ts`: login stamps the origin; refresh with a foreign or missing stamp makes zero fetches and throws |
| c | **Origin filter for persisted catalogs.** Drop stored and legacy models whose `baseUrl` host is neither the gateway host nor its subdomain. | `packages/ai/src/providers/radius.ts:50-79` | new case in `packages/ai/test/radius-provider.test.ts`: a stored `radius.pi.dev/v1` model under gateway `http://localhost:8788` is not restored |
| d | **Make `DRAHT_RADIUS_GATEWAY` real.** `ModelRuntime.create` builds the `radius` builtin as `radiusProvider({ gateway: getRadiusGatewayUrl() })`. This lives in coding-agent so `@draht/ai` diff stays small. Fix the env docs, which still describe relay. **Depends on b and c**: without them, this would create the F2/F3 leak. | `packages/coding-agent/src/core/model-runtime.ts:226-232`; `packages/coding-agent/docs/environment-variables.md` | new case in `packages/coding-agent/test/radius.test.ts`: with the env var set to a localhost faux gateway, `/v1/config` is fetched from it and not from `radius.pi.dev` |
| e | **Harden config `baseUrl`.** Reject a config whose `baseUrl` is not `https:` or whose host is neither the gateway host nor its subdomain. `http://localhost` is allowed only when the gateway itself is localhost. | `packages/ai/src/providers/radius-config.ts:42-50` | new case in `packages/ai/test/radius-provider.test.ts` (or a new `radius-config.test.ts`): config pointing at `https://evil.example/v1` raises `Invalid Radius config` |

Each row is one commit, with its own test, run from the package root as `AGENTS.md` requires, plus `npm run check`.

### 6.2 The flip (RG-9)

**Gate:** the gateway is at **E3** (RG-8) **and** RG-1 is merged. Everything below lands as one release, because each piece alone is unsafe (F3):

1. Set `DEFAULT_RADIUS_GATEWAY = "https://radius.draht.dev"` (`packages/ai/src/providers/radius-config.ts:4`).
2. Regenerate `packages/ai/src/providers/data/radius.json` with `generate-models.ts --strict`. `fetchRadiusModels` reads the default constant automatically (`generate-models.ts:1329-1342`). Per `AGENTS.md`, `models.generated.ts` is never edited by hand.
3. Add a new test in `packages/ai/test/radius-provider.test.ts`: every `RADIUS_MODELS` entry's `baseUrl` host equals the default gateway host or is its subdomain.
4. Rename `RADIUS_API_KEY` to `DRAHT_RADIUS_API_KEY` (D13) in `packages/ai/src/providers/radius.ts:37`, `packages/ai/src/env-api-keys.ts:104` and `packages/coding-agent/docs/providers.md:51`.
5. Update existing tests:
   - `packages/ai/test/radius-provider.test.ts:39-50`
   - `packages/coding-agent/test/radius.test.ts:124` (asserts on `radius.pi.dev/v1/config`)
   - `packages/coding-agent/test/radius-gateway.test.ts:31-33`
6. Make `DEFAULT_BUG_REPORT_GATEWAY` (`core/radius.ts:12`, working tree) an alias of `DEFAULT_RADIUS_GATEWAY`.
7. Add `### Breaking Changes` entries in `packages/ai/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md`.

### 6.3 Environment overrides

| Variable | Meaning | Default before flip | Default after flip |
|---|---|---|---|
| `DRAHT_RADIUS_GATEWAY` | Radius provider gateway origin (effective after RG-1d) | `https://radius.pi.dev` | `https://radius.draht.dev` |
| `DRAHT_BUG_REPORT_GATEWAY` | `/bug` upload destination (bug-report v1, working tree `core/radius.ts:13,21-24`) | `https://radius.draht.dev` | unchanged |
| `RADIUS_API_KEY` → `DRAHT_RADIUS_API_KEY` | static gateway key | `RADIUS_API_KEY` | `DRAHT_RADIUS_API_KEY` only |
| `DRAHT_OFFLINE` | disables catalog network refresh (`model-runtime.ts:239`) | — | — |
| `models.json` provider with `"oauth":"radius"` + `baseUrl` | additional gateways under other provider ids (`model-config.ts:234`; `provider-composer.ts:287-289,307`) | — | — |

### 6.4 Migration for users with radius.pi.dev credentials

- **Credential.** After the flip, a `radius` credential with a missing or foreign stamp is not used, not refreshed and not sent anywhere (RG-1b). The user sees a one-time notice: *"Your Radius sign-in was issued by radius.pi.dev; draht now uses radius.draht.dev. Run /login radius, or add a models.json provider for radius.pi.dev."* The stored credential is **kept, not deleted**: `AGENTS.md` says to ask before removing data (D12).
- **Catalog.** The persisted pi.dev catalog in `models-store.json` is filtered out (RG-1c) and replaced on the next refresh.
- **Keeping pi.dev's Radius.** Users add `{"providers":{"radius-pi":{"name":"Radius (pi.dev)","baseUrl":"https://radius.pi.dev","oauth":"radius"}}}` and run `/login radius-pi`. This path is proven by `packages/coding-agent/test/radius.test.ts:127-157`.
- **Saved model selections.** A saved selection `radius/<id>` whose id does not exist on draht's gateway falls back to `balanced` (`model-resolver.ts:21`). RG-9 asserts this.
- **Env key.** `RADIUS_API_KEY` stops being read, so a pi.dev key in the environment is never sent to draht.

---

## 7. Phased plan (risk-first)

Order: RG-0 → RG-1 (parallel) → RG-2 → RG-3 → RG-4 → RG-5 → RG-6 → RG-7 → RG-8 → RG-9. RG-1 depends on nothing server-side.

Test commands run from the package root. **No test uses a real provider key or paid tokens.** The single paid smoke is owner-run in RG-8.

**Test-runner note.** `AGENTS.md` gives `npx tsx ../../node_modules/vitest/dist/cli.js --run <file>`. That path does not resolve under bun's install layout, so RG-0 adds a `test` script to `packages/radius-gateway/package.json` and the commands below use it, as `npm test -- --run <file>` scoped to that package.

### RG-0 — Contract harness and transport evidence (riskiest; local only)

- **Deliverables:**
  - `packages/radius-gateway/` with `src/protocol/` (schemas for §3.6–3.7), `src/inference/event-mapper.ts`, `src/inference/sse.ts` and `src/server.ts`. The server answers `POST /v1/messages` over Node http, using `@draht/ai`'s faux provider (`packages/ai/src/providers/faux.ts:687`) as the only upstream.
  - `packages/radius-gateway/test/contract/pi-messages-client.test.ts`, which drives the **real** client `stream()` from `packages/ai/src/api/pi-messages.ts` against `127.0.0.1`.
  - `packages/radius-gateway/scripts/measure-request-sizes.mjs`, which reads local session JSONL. It is read-only and makes no network calls. It reports p50/p95/p99/max serialised request bytes and output tokens per turn.
- **Acceptance:** the client-observed `AssistantMessage` equals the faux upstream's message for each of:
  - text
  - thinking with a signature
  - redacted thinking
  - two tool calls with streamed JSON
  - `done` with usage, where cost is recomputed from the catalog

  Also:
  - Pre-stream 401/402/404/413/429(rate)/429(quota)/503 each classify exactly as in §3.7, checked through `isRetryableAssistantError` and `isContextOverflow`.
  - Heartbeats interleaved anywhere are tolerated.
  - A client abort aborts the faux upstream's signal within 1 s.
  - A stream that ends without a terminal event gives the client's error.
  - The measurement report is produced and **D1 is recorded** from its numbers.
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/contract/pi-messages-client.test.ts`, then `npm run check` at the root.
- **Evidence:** E1 (faux upstream is named).

### RG-1 — Client credential safety (client only)

- **Deliverables:** §6.1 a–e, in that order. Row (a) is urgent because of bug-report v1.
- **Acceptance:** each row's named test passes and `npm run check` is clean.
- **Verification:** `cd packages/ai && npm test -- --run test/radius-oauth.test.ts test/radius-provider.test.ts`, and `cd packages/coding-agent && npm test -- --run test/radius.test.ts test/bug-report-upload-origin.test.ts` (or each package's established runner).
- **Evidence:** E0/E1.

### RG-2 — Deploy pipeline and staging transport proof on AWS

- **Depends on:** RG-0, D1, D9, D10.
- **Deliverables:**
  - `.github/workflows/deploy-radius.yml`: manual `workflow_dispatch`, a GitHub environment with a required reviewer, an OIDC role, and `sst deploy --stage staging`.
  - SST resources for `Vpc`, `Cluster` and `Service` at `inference.radius-staging.draht.dev`, running the RG-0 server with only the faux upstream.
  - The `Dockerfile`.
- **Acceptance:** the real client `stream()`, run from a workstation against staging, shows:
  1. a 20-minute faux stream with heartbeats completes;
  2. 8 MB and 24 MB request bodies are accepted, and a 33 MB body gets 413 `request_too_large`;
  3. a client abort produces an upstream-abort log line within 2 s;
  4. redeploying the previous image digest restores the prior behaviour (rollback);
  5. `sst remove --stage staging` leaves no tagged resources.
- **Verification:** `node packages/radius-gateway/scripts/staging-transport-probe.mjs --base https://inference.radius-staging.draht.dev/v1` (a deliverable of this phase), with its output archived as phase evidence.
- **Evidence:** E1 (real AWS boundary, faux upstream).

### RG-3 — OAuth authorization server and accounts

- **Depends on:** RG-0 (package), D2.
- **Deliverables:**
  - `src/oauth/{discovery,authorize,device,token,tokens}.ts`
  - `src/web/` pages for authorize, device and minimal account
  - `src/store/{dynamo,memory}.ts`
  - Lambda adapters and SST routes
  - GitHub OAuth app secrets
- **Acceptance:** the **real** `createRadiusOAuth` (`packages/ai/src/auth/oauth/radius.ts:275`) completes, against the in-process server:
  - **Device flow:** `pending`, then `slow_down` when polled early, then success; also `expired_token` after TTL and `access_denied` on deny.
  - **Browser flow:** a scripted HTTP client with a test session cookie approves and follows the redirect to `127.0.0.1:1456`.

  Also:
  - Every token response carries `refresh_token`.
  - Refresh rotates; reuse of a rotated refresh token revokes the family.
  - A mismatched `redirect_uri` or PKCE verifier gives `invalid_grant`, and `plain` is rejected.
  - An API key can be created, used on `/v1/config` and revoked.
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/oauth/*.test.ts`. The store runs in-memory (E0); a DynamoDB Local run gives E1, and DynamoDB Local is named as the substitution.
- **Evidence:** E1.

### RG-4 — `/v1/config` catalog

- **Depends on:** RG-3 (token validation).
- **Deliverables:** `catalog/catalog.json` with the D7 model set and `balanced`/`cheap`/`precise` aliases; `src/catalog/build.ts`; `src/catalog/pricing.ts`; the config Lambda.
- **Acceptance:**
  - `loadRadiusGatewayConfig` (`radius-config.ts:80-96`) parses public and authenticated responses, and `getRadiusModelsFromConfig` yields every model.
  - Every model's `cost` equals `pricing.ts`'s charge for 1M tokens of each class.
  - An invalid token gets 401 in the dialect of §3.0.
  - Cache headers are as in §3.5.
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/catalog/config.test.ts`.
- **Evidence:** E0.

### RG-5 — Inference proxy with real adapters (faux in tests)

- **Depends on:** RG-0, RG-3, RG-4.
- **Deliverables:** auth, allowlist validation, catalog resolution, upstream dispatch through `@draht/ai` adapters, key injection from env/secret, scrubber, `sessionId` namespacing, cache salt (D8), reasoning clamp, cost recompute, abort propagation, structured allowlist logger with a lint gate.
- **Acceptance:**
  - **T4a:** a body carrying `baseUrl`, `headers` and an object `model` reaches the faux upstream with server configuration only.
  - **T4b:** the scrubber redacts key-shaped strings in upstream errors.
  - **T5b:** cross-account cache isolation, as in §5.
  - **Content-never-stored canary:** a request carrying `RADIUS-CANARY-<uuid>` in system text, user text, tool result and image bytes runs end to end. The captured logger output and every `Store` write contain neither the canary nor any `drt_`/`drk_` string.
  - **Per-provider adapter usage completeness (A7):** recorded-fixture tests per v1 upstream adapter show complete usage.
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/inference/*.test.ts`; `npm run check`.
- **Evidence:** E1.

### RG-6 — Metering, credits and payments

- **Depends on:** RG-5, D3, D4.
- **Deliverables:** holds, settlement and leases; ledger; webhook Lambda; spend caps; `/account` balance and usage views.
- **Acceptance:**
  - A property test of 100 concurrent requests against the in-memory store, which models DynamoDB conditional writes, never overdraws beyond the stated slop.
  - The same holds on DynamoDB Local.
  - An exhausted hold mid-stream emits the §3.7 message and the client classifies it as non-retryable.
  - A replayed webhook credits once.
  - Settlement is idempotent on `requestId`.
  - A payment-provider sandbox purchase credits the account end to end (E1, sandbox named).
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/metering/*.test.ts`.
- **Evidence:** E1.

### RG-7 — Limits, kill switch, observability, runbook

- **Depends on:** RG-5, RG-6.
- **Deliverables:** §4.7 limits; SSM kill switch + spend alarm + auto-flip Lambda; §4.9 metrics, alarms and the faux `canary` model; `packages/radius-gateway/RUNBOOK.md` (key rotation, upstream console spend limits, suspension script, rollback).
- **Acceptance:**
  - Each limit returns the exact §3.7 code and text.
  - Flipping the parameter yields 503 within 30 s.
  - The canary model completes without upstream keys.
  - On staging, a forced 5xx burst fires the alarm (E1 on AWS).
- **Verification:** `cd packages/radius-gateway && npm test -- --run test/limits/*.test.ts`, plus the staging probe script with `--kill-switch` and `--burst` modes.
- **Evidence:** E1.

### RG-8 — Production launch (E3)

- **Depends on:** RG-2..RG-7, D5, D6, D7, D9.
- **Deliverables:**
  - Production stage at `radius.draht.dev` and `inference.radius.draht.dev`.
  - ToS, privacy policy and Impressum pages.
  - Invite-only sign-up.
  - A PRODUCT-MAP amendment (owner edit) classifying the gateway.
- **Acceptance (E3, per draht-mono `RELEASE-EVIDENCE.md`)**, on the active deployment, each read back independently:
  - real login (device and browser) from a released draht build pointed with `DRAHT_RADIUS_GATEWAY`
  - refresh after expiry
  - `/v1/config` readback
  - one owner-run paid smoke per v1 upstream with a minimal prompt
  - usage record and balance-debit readback
  - kill switch
  - rollback to the previous image digest
  - CloudWatch logs inspected for content (none present)
- **Verification:** an owner-run checklist archived as an evidence file under draht-mono `.planning/`.

### RG-9 — Client flip

- **Depends on:** RG-8 at E3, RG-1 merged.
- **Deliverables:** §6.2 items 1–7.
- **Acceptance:**
  - The new and updated tests pass.
  - A fresh `HOME` with a legacy unstamped `radius` credential and a pi.dev catalog in `models-store.json` makes **zero** requests to `radius.pi.dev`, checked with a fetch spy, and shows the one-time notice.
  - A saved `radius/<unknown>` selection resolves to `balanced`.
- **Verification:** `cd packages/ai && npm test -- --run test/radius-provider.test.ts test/radius-oauth.test.ts`; `cd packages/coding-agent && npm test -- --run test/radius.test.ts test/radius-gateway.test.ts`; `npm run check`.
- **Evidence:** E1 for the client and E3 for the gateway, recorded separately (do not average).

---

## 8. Open decisions for the owner

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Data-plane transport | A HTTP API + Lambda · B REST API + streaming Lambda · C Function URL + CloudFront · D Fargate + ALB | **D**, unless RG-0 shows p99 request < 4 MB **and** p99 stream < 10 min, in which case **C** for zero fixed cost |
| D2 | Identity at the authorize and device pages | GitHub OAuth · email magic link (SES) · passkeys · Cognito hosted UI | **GitHub OAuth only at launch**: developer audience, no password storage, and account age is an abuse signal. Add email OTP later. |
| D3 | Payment provider | Stripe (+ Stripe Tax; draht is seller of record → EU VAT OSS filing, invoices, long retention) · Paddle (merchant of record) · Polar (MoR, usage-billing native) · Lemon Squeezy (MoR) | **A merchant of record (Paddle)** with prepaid packs as one-time products, to keep B2C EU VAT off a solo operator. Stripe only if B2B-only. |
| D4 | Pricing and currency | Pass-through + flat markup · + per-request fee · subscription tiers; USD vs EUR credits | **USD-denominated prepaid credits** (catalog `cost` is $/Mtok and the client shows it verbatim, F5) with a **flat markup percentage set by the owner**, and no subscription |
| D5 | Free tier or trial | None · one-time trial credit gated on GitHub account age · invite codes | **Invite-only beta with no free credit**, revisited after RG-8 |
| D6 | Legal: entity, ToS, privacy policy, Impressum, **upstream terms permitting a pass-through gateway** | Self-review · counsel review · enterprise agreements with upstreams | **Counsel review before RG-8; launch is blocked on it.** Confirm for each v1 upstream that resale or proxying is permitted. |
| D7 | v1 upstream set and data retention | Mirror pi.dev's 28 models · a small set | **Anthropic + OpenAI + one open-weights host (Fireworks)**, each with a signed DPA and zero-retention or opt-out where offered; aliases `balanced`/`cheap`/`precise` |
| D8 | Prompt-cache tenant isolation | Per-account cache salt · accept shared cache | **Salt** (T5b) |
| D9 | AWS account and deploy ownership | Existing account · dedicated account; who approves deploys | **Dedicated AWS account** for Radius, `radius.draht.dev` NS delegated from the `draht.dev` Route 53 zone, deploys only through the RG-2 workflow with the owner as required reviewer |
| D10 | Code and stack placement | Extend `packages/infra` and reclassify it from Example · new private `packages/radius-gateway` with its own `sst.config.ts` (app `draht-radius`) | **New `packages/radius-gateway` with its own SST app.** PRODUCT-MAP says an Example package "may be removed without compatibility support", which contradicts hosting production there. Move the bug-report v1 Lambda into it at RG-2; `/bug` keeps zip export as the fallback during the short domain cut-over. |
| D11 | OAuth `client_id` on the wire | Keep `pi-gateway` · rename to `draht-cli` | **Keep `pi-gateway`.** It is an opaque protocol identifier the user never sees, and keeping it avoids a recurring sync conflict in `@draht/ai`. |
| D12 | Legacy radius.pi.dev credential after the flip | Keep and ignore · delete on detection · auto-move to a `radius-pi` provider id | **Keep and ignore**, with a one-time notice |
| D13 | Rename `RADIUS_API_KEY` | Keep · rename to `DRAHT_RADIUS_API_KEY` at the flip | **Rename**, so a pi.dev key in env never reaches draht's gateway |
| D14 | Bug report with an invalid Bearer | Accept anonymously (`attributed:false`) · 401 | **Accept anonymously**, because a report is worth more than its attribution |

---

## 9. Risks and assumptions

### Assumptions (each with how to confirm)

| # | Assumption | Confirm by |
|---|---|---|
| A1 | AWS limits: Lambda request payload 6 MB and 15 min maximum; HTTP API cannot stream and has a 30 s integration timeout; CloudFront origin response timeout defaults to 30 s; WAF does not attach to HTTP APIs. | Check current AWS docs during RG-0; RG-2 probes measure transport limits directly. |
| A2 | `sst@4.2.1` (`packages/infra/package.json`) installs a platform with the same `Function.streaming`, `Service`/`loadBalancer` and `Dynamo` TTL API as the vendored copy cited in §4.2. | In RG-2, run `sst install` in the new package, which writes `.sst/platform` locally and does not deploy, then read the component sources. |
| A3 | `@draht/ai` adapters run in a Node 22 container without CLI-only modules; the OAuth callback server is CLI-only per `radius.ts:8-9`, and the inference path does not import it. | Bundle `src/server.ts` in RG-0 and assert the bundle has no `node:http` server import outside `server.ts`. |
| A4 | The client sends a normalised `TranscriptContext` that upstream adapters accept unchanged, including `sections` and `toolsAdded`. | RG-0 contract test with sections and tool deltas. |
| A5 | Bug-report v1 deploys to `radius.draht.dev` on an API Gateway in `packages/infra`. | Read the in-flight agent's commit when it lands. |
| A6 | `draht.dev` DNS is Route 53 (`packages/landing/sst.config.ts:16-21` uses `sst.aws.dns()`). | Owner confirms the hosted zone and account (D9). |
| A7 | `@draht/ai` adapters report complete usage on normal termination for every v1 upstream. | RG-5 recorded-fixture tests per adapter. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Upstream-sync conflicts:** RG-1 and RG-9 edit `@draht/ai` files that pi changes often (`auth/oauth/radius.ts`, `providers/radius.ts`, `radius-config.ts`). | Keep diffs minimal and test-pinned; prefer coding-agent-side wiring (RG-1d); note the edits in the sync log for the next slice. |
| R2 | **Protocol drift:** a future pi sync adds `pi-messages` event types or fields the gateway does not emit or accept. | The RG-0 contract tests import the client from the repo, so a sync that changes the client fails CI before release. |
| R3 | **Legal and upstream-terms exposure** (D6), the largest non-technical risk. | Launch is gated on D6. |
| R4 | Fixed cost (Fargate + ALB, plus WAF) against low early usage. | D1 escape hatch to option C; `min: 1` small ARM task. |
| R5 | Operating a 24/7 paid service as a solo operator. | The prepaid model plus kill switch makes the failure mode **unavailability, not unbounded debt**; runbook (RG-7). |
| R6 | Estimated charges on aborted streams over- or under-charge. | Documented `estimated:true` flag on usage records; conservative estimator; a refund path via ledger `adjustment`. |
| R7 | Thinking-signature replay breaks if a model id is ever routed to a different upstream mid-session. | v1 maps one upstream per id; any future multi-upstream routing must be sticky on `(account, sessionId, model)`. |
| R8 | PRODUCT-MAP classifies `@draht/infra` as a removable Example. | D10. |
| R9 | **F4 ships with bug-report v1 if not fixed now.** | RG-1a runs before or alongside v1. **Flag to the bug-report agent.** |
| R10 | The flip changes behaviour for existing pi Radius users. | One-time notice, `models.json` escape hatch, `Breaking Changes` changelog entries (§6.2, §6.4). |

**Where this plan is most likely wrong:**
- **Transport** (D1/A1/A2). RG-0 and RG-2 check exactly that, before any OAuth or billing work is built on top.
- **Legal permission to resell upstream access** (D6), which no code phase can prove and which gates RG-8.
