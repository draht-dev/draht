# Phase 34 — Permission Relay: execution plan

> Produced 2026-08-21 by workflow `wf_08536a00-ffc` (six read-only lenses, two Fable 5 advisors at
> max effort, one max-effort planner). Where the advisors corrected the map or the requirements, the
> advisors won; every such override is recorded under Ordering constraints.

## Design

Phase 34 relays permissions over the ATTACH WIRE, in four gated waves.

The relay is a RelayUIContext DECORATOR installed at exactly one line — packages/coding-agent/src/core/agent-session.ts:2360 inside `_applyExtensionBindings`, the only production caller of ExtensionRunner.setUIContext — reached by interactive/rpc/print via bindExtensions (:2301) and by draht-acp/SDK via the constructor's _buildRuntime (:401 -> :2642), and re-run on reload (:2661), so it survives /new /resume /fork /import.
main.ts hands the relay HANDLE to the session right after makeSessionAttachable (main.ts:916) and re-hands it inside the EXISTING addSessionReplacedListener (main.ts:935-938). main.ts never installs the wrap itself: bindExtensions later assigns _extensionUIContext and would overwrite it.
The decorator wraps only confirm/select/input and hand-delegates the other ~25 ExtensionUIContext members (no Proxy — the synchronous getters must stay local; editor and custom stay local by documented exception).
ExtensionRunner.hasUI() stops being an identity check against noOpUIContext (runner.ts:464-466) and consults an optional hasAnswerSurface(), which the decorator implements as "base context is live OR >=1 read-write client is attached". An attachable session with nobody attached therefore KEEPS today's loud fail-closed block at subagent.ts:602 instead of fabricating "User denied approval".
The gate at subagent.ts:605 stops passing a prose sentence: it passes toolCallId, toolName, canonical (realpath) cwd, the command/path from event.input, and a frozen offered-option set, through a new optional `detail` field on ExtensionUIDialogOptions. The RPC public protocol carries the same payload, so all surfaces share one shape.
The pending registry lives on the relay object inside makeSessionAttachable's bind closure — never in the decorator (the ExtensionRunner is rebuilt on every reload) and never in geist-core (boundary gate forbids importing coding-agent). settle() is synchronous from validation through resolve(); the order is settle -> resolve -> abort losing surfaces -> broadcast resolution -> append a PermissionResolutionEntry to the session JSONL (CURRENT_SESSION_VERSION stays 3).
The wire change is ONE atomic train: socket-server ClientMessage/ServerMessage gain permission frames plus an attach-time capability field, geist-protocol mirrors them field-for-field, GEIST_PROTOCOL_VERSION goes 0.2 -> 0.3, MIRRORED_FRAMES gains rows, MIGRATIONS.md gains a `## geist/0.3` section, conformance/geist-0.3/ is regenerated from the real recorder, and AttachBridge learns the client->session answer arm. The build gates make any split fail.
Emission is capability-gated at attach: an older bridge that never declares support is never sent a permission frame, so it is never dropped with close 1008.
Neutralize-and-bound happens where the frame is CONSTRUCTED (a new safe-text module: NFC + surrogate repair, one-for-one visible-marker replacement of C0/DEL/C1/bidi/invisibles, grapheme-safe MIDDLE elision preserving the decisive tail, shipped as {value, truncated, originalLength}) and is re-asserted in wire.ts with .refine(), never .transform().
Every requirement-closing test drives the emitted binary (packages/coding-agent/dist/cli.js) or the public protocol end to end. The enabler that makes that possible is a stub provider taught to emit scripted tool calls offline.

## Tasks

### T1 — Stub provider emits scripted tool calls

- **Wave** 1 · **Requirement** R34-PERM.7 (enabler for every Class-3 test in this phase) · **Evidence class** 3 · **Depends on** nothing
- **Files** `packages/coding-agent/src/extensions/stub-provider/provider.ts`, `packages/coding-agent/test/stub-provider-scripted-tool-calls.e2e.test.ts`
- **Test** `packages/coding-agent/test/stub-provider-scripted-tool-calls.e2e.test.ts`

CONTEXT. The repo is /Users/exe008/draht/draht-mono (a bun/npm monorepo). `packages/coding-agent` emits a CLI binary at `packages/coding-agent/dist/cli.js` (built with `bun run build` from that package). It ships a hidden, env-gated keyless provider so a SPAWNED binary can answer prompts with no API key: `packages/coding-agent/src/extensions/stub-provider/provider.ts`. It is enabled with `DRAHT_STUB_PROVIDER=1` and selected with `--provider draht-stub --model stub-1`.

PROBLEM. The stub can only answer with TEXT. `createStubProvider()` builds its response factory as `fauxAssistantMessage(stubReplyFor(lastUserText(context.messages)))` (provider.ts, around lines 80-86). Because of that, NO test can make the emitted binary issue a real tool call offline, and every Class-3 test in this phase needs one.

WHAT TO BUILD. In `packages/coding-agent/src/extensions/stub-provider/provider.ts` ONLY:
1. Export `export const STUB_PROVIDER_TOOL_CALLS_ENV = "DRAHT_STUB_TOOL_CALLS";` next to the existing `STUB_PROVIDER_ENV` / `STUB_PROVIDER_TOKENS_PER_SECOND_ENV` constants.
2. When that env var is present, parse it as JSON: an array of TURN SCRIPTS. Turn N of the session uses script N; once the scripts are exhausted the provider falls back to today's text reply forever (the existing self-requeueing behaviour must be preserved). Each turn script is `{ "toolCalls": [ { "id": string, "name": string, "arguments": object } ], "text"?: string }`. Emit the tool calls with `fauxToolCall(name, arguments_, { id })`, which already exists at `packages/ai/src/providers/faux.ts:57` and whose stream already emits `toolcall_end` (faux.ts:390). Import it from `@draht/ai/providers/faux` alongside the existing `fauxAssistantMessage` import.
3. Malformed JSON must NOT crash the binary: fall back to text-only and write one line to stderr.
4. With the env var ABSENT, behaviour must be byte-identical to today. Do not change `stubReplyFor`, `STUB_REPLY_PREFIX`, `lastUserText`, or the tokensPerSecond/tokenSize pinning — five existing e2e suites depend on them.
5. Do NOT edit `packages/coding-agent/src/extensions/stub-provider/index.ts`.

THE TEST THAT PROVES IT (write it at `packages/coding-agent/test/stub-provider-scripted-tool-calls.e2e.test.ts`, vitest: import `describe`/`test`/`expect` from "vitest"). It must drive the EMITTED BINARY, not the module:
- Build first: `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build`.
- Spawn `node /Users/exe008/draht/draht-mono/packages/coding-agent/dist/cli.js --provider draht-stub --model stub-1 --mode json -p --no-session "run the tool"`.
- Environment: start from `process.env`, then DELETE `DRAHT_PERMISSION_MODE` (this repo's interactive shell exports `auto`; a test that inherits it proves nothing), set `DRAHT_STUB_PROVIDER=1`, set `DRAHT_STUB_TOOL_CALLS` to a JSON array scripting ONE `bash` call whose `command` writes a marker file into a temp dir, and set `DRAHT_CODING_AGENT_DIR` to a directory created directly under `/tmp` with a SHORT name (a Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS `os.tmpdir()` is already ~50 chars).
- Assert A: the emitted JSON stream on stdout contains a tool-call event for tool name `bash` carrying the scripted command text. This proves the emitted binary really issued the tool call.
- Assert B: with `DRAHT_PERMISSION_MODE=yolo` added to the same spawn, the marker file EXISTS afterwards — i.e. the scripted call actually executed.
- Assert C: with `DRAHT_STUB_TOOL_CALLS` absent, the run still produces the plain `stub: ` text reply (no regression).
- Give each spawning test an explicit timeout of at least 60000ms (the vitest default in `packages/coding-agent/vitest.config.ts` is 30000). Kill the child in a `finally`.

RUN ONLY YOUR OWN TEST FILE. Do not run the package suite; it flakes under parallel load:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && env -u DRAHT_PERMISSION_MODE npx vitest --run test/stub-provider-scripted-tool-calls.e2e.test.ts`

Do not touch any file outside the two listed above.

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/extensions/stub-provider/provider.ts packages/coding-agent/test/stub-provider-scripted-tool-calls.e2e.test.ts

### T2 — safe-text: neutralize control/bidi one-for-one, bound with a tail-preserving middle elision

- **Wave** 1 · **Requirement** R34-PERM.4 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/coding-agent/src/core/socket-server/safe-text.ts`, `packages/coding-agent/test/socket-safe-text.test.ts`
- **Test** `packages/coding-agent/test/socket-safe-text.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. This repo has NO protocol-layer sanitizer. Every existing helper is renderer-local, DELETES rather than marks, and none touches bidi: `stripAnsi` (packages/coding-agent/src/utils/ansi.ts:46) keeps DEL and a lone ESC; `sanitizeBinaryOutput` (packages/coding-agent/src/utils/shell.ts:144) keeps U+202E RLO, U+202D, U+2066, U+200E, U+007F and U+009B; `truncateToWidth` (packages/tui/src/utils.ts:969) is HEAD-preserving, injects ANSI resets, and can cut inside an override run leaving it unterminated. Do NOT reuse any of them.

WHY THIS MATTERS. A permission ask carries an attacker-influenced command string. Its decision-relevant content is its TAIL (`... | sh   # AND THEN rm -rf ~/.ssh`); head-truncation deletes exactly that. Bidi overrides cost ZERO display width in this codebase (`visibleWidth(U+202E) === 0`, packages/tui/src/utils.ts:249), so a width budget cannot price a spoof out. And DELETING a control character silently welds `rm -r` + `f /` into `rm -rf /`, making the displayed string differ from the executed one with no evidence.

WHAT TO BUILD — one NEW pure module, no I/O, no imports from socket-server siblings:
`packages/coding-agent/src/core/socket-server/safe-text.ts`

Export `export interface BoundedText { value: string; truncated: boolean; originalLength: number; }` and `export function boundedSafeText(raw: string, maxGraphemes: number): BoundedText`.

FOUR steps, in this exact order:
1. NORMALIZE — `raw.normalize("NFC")`, then repair unpaired surrogates. Reuse `sanitizeSurrogates` from `packages/ai/src/utils/sanitize-unicode.ts:21` if it is publicly exported from `@draht/ai`; if not, replicate the ~5-line implementation locally with a comment naming that file as the source.
2. NEUTRALIZE, NEVER DELETE — replace EACH offending code point with EXACTLY ONE visible marker code point, so length semantics are preserved. For C0 (U+0000-U+001F, including ESC/CR/LF/TAB) emit the Control Pictures glyph `String.fromCodePoint(0x2400 + cp)`. For DEL (U+007F), C1 (U+0080-U+009F), every bidi format/isolate (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) and every invisible (U+00AD, U+200B-U+200D, U+2060, U+FEFF, U+FFF9-U+FFFB, variation selectors U+FE00-U+FE0F, tags U+E0000-U+E007F) emit U+FFFD. Do NOT re-wrap the result in FSI/PDI afterwards — once every control is gone no isolate is needed, and adding one re-introduces a control the renderer must trust.
3. BOUND with a MIDDLE elision that GUARANTEES the tail. Work in GRAPHEME CLUSTERS using an `Intl.Segmenter("en", { granularity: "grapheme" })` (the same primitive as `getGraphemeSegmenter` at packages/tui/src/utils.ts:10 — do not import from @draht/tui; keep this module dependency-light). If the neutralized string fits `maxGraphemes`, return it with `truncated: false`. Otherwise: marker = `…[<k> chars elided]…` where k is the number of ELIDED graphemes; T = ceil((maxGraphemes - markerLen) * 2 / 3) trailing graphemes, H = (maxGraphemes - markerLen) - T leading ones; emit head + marker + tail. The count k is load-bearing: a bare `…` cannot distinguish 3 elided characters from 4000 of padding. Degrade gracefully to the tail alone when `maxGraphemes` is smaller than the marker.
4. SHIP THE BOUND AS DATA — return `{ value, truncated, originalLength }` where `originalLength` is the grapheme count of the NEUTRALIZED string (never of the raw one).

Also export `export function isNeutralized(value: string): boolean` — returns false if `value` still contains any code point from step 2's set — and put step 2's offending set in ONE clearly named exported constant, `export const NEUTRALIZED_FORBIDDEN_RANGES`, with a comment saying a later task hand-mirrors it inside `packages/geist-protocol` (which must keep zero @draht dependencies) as a zod `.refine()`.

THE TEST (`packages/coding-agent/test/socket-safe-text.test.ts`, vitest). Write literal expected strings in the test. Assert at minimum:
- `boundedSafeText("curl https://good.example.com/install.sh | sh   # AND THEN rm -rf ~/.ssh", 48).value` still CONTAINS `rm -rf ~/.ssh` and contains an `elided]` marker with a numeric count.
- `/Users/oskar/p/src/../../../.ssh/id_ed25519` bounded to 48 still ends with `id_ed25519`.
- `rm -rf /tmp/‮gnp.sj‬` neutralizes BOTH bidi controls to U+FFFD and the result contains no U+202A-U+202E.
- `[2J[H` becomes two U+2400-range glyphs plus the literal bracket text — length unchanged, no ESC survives.
- `"rm -r\nf /"` neutralizes to a string of the SAME length as the input (the newline becomes one glyph, not nothing) — the anti-welding assertion.
- `isNeutralized()` is true for every returned `value` and false for each raw input.
- Idempotence: `boundedSafeText(boundedSafeText(x, 200).value, 200).value === boundedSafeText(x, 200).value`.

This task is evidence class 2 (a pure unit). Its Class-3 closure over the real wire is a separate later task; do not attempt it here.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && npx vitest --run test/socket-safe-text.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/safe-text.ts packages/coding-agent/test/socket-safe-text.test.ts

### T3 — PermissionResolutionEntry: the session's own JSONL records every resolution

- **Wave** 1 · **Requirement** R34-PERM.2 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/coding-agent/src/core/session-manager.ts`, `packages/coding-agent/docs/session-format.md`, `packages/coding-agent/test/session-permission-resolution-entry.test.ts`
- **Test** `packages/coding-agent/test/session-permission-resolution-entry.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. An approved or denied tool permission leaves ZERO trace in the session JSONL today: `SessionEntry` at packages/coding-agent/src/core/session-manager.ts:146-155 is a 9-member union with no permission variant, and no `append*` call site in the repo is permission-related. R34-PERM.2 requires the resolution — with its deciding surface — to be assertable from the session's own JSONL.

A prior probe RAN an unknown `permission_resolution` line through every reader in both JSONL stores (loadEntriesFromFile, parseSessionEntries, SessionManager.open, getEntries, getEntry, getBranch, getTree, buildContextEntries, buildSessionContext, sessionEntryToContextMessages, listAll, and packages/agent/src/harness/session/jsonl-storage.ts) with zero throws. Adding the variant is additive-safe. Two hard constraints from that run are NOT negotiable:
- `CURRENT_SESSION_VERSION` at session-manager.ts:30 MUST STAY 3. packages/agent/src/harness/session/jsonl-storage.ts:77 hard-throws `unsupported session version` on anything else. Do not 'correctly' version this schema addition.
- The entry MUST extend `SessionEntryBase` (session-manager.ts:46-51) so it carries `id`, `parentId` and `timestamp`. jsonl-storage.ts:103-131 validates structure and throws per line without them.

WHAT TO BUILD in packages/coding-agent/src/core/session-manager.ts:
1. Declare, next to `CustomMessageEntry` (around line 143):
```
export interface PermissionResolutionEntry extends SessionEntryBase {
	type: "permission_resolution";
	requestId: string;
	toolCallId: string;
	toolName: string;
	cwd: string;
	detail: { command?: string; path?: string; operation?: string };
	offeredOptionIds: string[];
	decision: "approved" | "denied" | "cancelled" | "expired";
	chosenOptionId: string | null;
	decidedBy: { surface: "tui" | "attach" | "rpc" | "acp" | "system"; clientId: string | null };
	requestedAt: string;
	deadline: string | null;
}
```
2. Add `| PermissionResolutionEntry` to the `SessionEntry` union at :146-155.
3. Add a public `appendPermissionResolution(...)` next to `appendSessionInfo` (session-manager.ts:1151-1160), following the exact shape of `appendCustomEntry` (:1137-1146): build the entry with the same id generator, `this.leafId` as parentId and `new Date().toISOString()` as timestamp, then call `this._appendEntry(entry)` (:1058). Return the new entry id.
4. Do NOT add a case to `sessionEntryToContextMessages` — the fall-through `return []` is correct and keeps the entry out of LLM context.

KNOWN, ACCEPTED SIDE EFFECTS — write a short doc comment on the interface naming each: (a) `_buildIndex` sets `leafId` to the last entry unconditionally (session-manager.ts:972-990), so this entry becomes the leaf and the next message parents off it; (b) `createBranchedSession` (:1435-1443) copies path entries verbatim into a fork, duplicating requestId/toolCallId — therefore this JSONL record is a RECORD ONLY and must never be treated as answerable state; (c) the RPC `get_entries` command ships `SessionEntry[]` verbatim (packages/coding-agent/src/modes/rpc/rpc-types.ts:200), so this widens what an RPC client sees.

In packages/coding-agent/docs/session-format.md, add a `PermissionResolutionEntry` section to the Entry Types catalogue (existing per-type sections start around line 187) with one sample JSONL line, matching the surrounding style.

THE TEST (`packages/coding-agent/test/session-permission-resolution-entry.test.ts`, vitest). Against a REAL on-disk SessionManager in a temp dir:
- Create a session, append a user message and an assistant message (required: `_persist` at session-manager.ts:1029-1055 buffers everything in memory until the FIRST ASSISTANT MESSAGE, so nothing is on disk before that), then `appendPermissionResolution(...)`.
- Assert the raw .jsonl file's last line parses to `type === "permission_resolution"` with the exact fields set and non-empty `id`/`parentId`/`timestamp`.
- Reload with `SessionManager.open` and assert `getEntries()` includes it, `getTree()` succeeds, and `buildSessionContext(...)` yields only the user/assistant roles (the entry never enters LLM context).
- Append another message after it and assert its `parentId` equals the permission entry's id (documents the leaf move).
- Assert `CURRENT_SESSION_VERSION` is still `3` and the written header's `version` is `3`.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && npx vitest --run test/session-permission-resolution-entry.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-permission-resolution-entry.test.ts

### T4 — Honest surface arbitration + the RelayUIContext decorator at the one mode-agnostic seam

- **Wave** 1 · **Requirement** R34-PERM.2 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/permission-relay/types.ts`, `packages/coding-agent/src/core/permission-relay/relay-ui-context.ts`, `packages/coding-agent/src/core/permission-relay/index.ts`, `packages/coding-agent/test/relay-ui-context-surface.test.ts`
- **Test** `packages/coding-agent/test/relay-ui-context-surface.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. draht has ONE mode-agnostic place where a mode's `ExtensionUIContext` is pushed into the extension runner: `runner.setUIContext(this._extensionUIContext, this._extensionMode)` at packages/coding-agent/src/core/agent-session.ts:2360, inside `_applyExtensionBindings` (:2359). A repo-wide scan proved it is the ONLY production caller of `ExtensionRunner.setUIContext` (runner.ts:455-458). It is reached from `bindExtensions` (:2281 -> :2301, used by interactive/rpc/print) AND from `_buildRuntime` (:2642), which the constructor calls at :401 — so draht-acp and every SDK session pass through the same line without ever calling bindExtensions — and it re-runs on reload (:2661). That is why the decorator goes THERE and nowhere else.

THE HAZARD YOU MUST NOT CREATE. `ExtensionRunner.hasUI()` at runner.ts:464-466 is `return this.uiContext !== noOpUIContext` — an IDENTITY check. Any wrapper object flips it true. Four consumers read it (packages/coding-agent/src/core/builtins/subagent.ts:602 and :958, packages/coding-agent/src/core/builtins/checkpoints.ts:91, packages/coding-agent/src/core/project-trust.ts). If a decorator flips hasUI true while NOTHING can answer, today's loud fail-closed block turns into the wrapped no-op's instant `false`, which subagent.ts:606-608 reports as "User denied approval" — a FABRICATED user action in the transcript. Preventing that is half this task.

WHAT TO BUILD.

(1) packages/coding-agent/src/core/extensions/types.ts:
- Add an optional structured detail carrier to `ExtensionUIDialogOptions` (currently `{ signal?, timeout? }` at :103-108): `detail?: PermissionAskDetail`, with `PermissionAskDetail` exported from this file as `{ kind: "tool_permission"; toolCallId: string; toolName: string; cwd: string; command?: string; path?: string; operation?: string; reason: string; options: readonly { id: string; label: string }[] }`. Optional trailing data on an existing options object is the only backwards-compatible shape — third-party extensions implement `ExtensionUIContext`.
- Add an OPTIONAL member to `ExtensionUIContext` (declared at :138 onward): `hasAnswerSurface?(): boolean;`, documented as "true only while some surface can actually answer right now". Optional, so no existing implementer breaks.

(2) packages/coding-agent/src/core/extensions/runner.ts:
- Change `hasUI()` (:464-466) to `return this.uiContext !== noOpUIContext && (this.uiContext.hasAnswerSurface?.() ?? true);`. Nothing else. `createContext()`'s `get hasUI()` (:704-707) is already a live getter — do not cache it.

(3) NEW packages/coding-agent/src/core/permission-relay/types.ts — the port the decorator talks to, with NO socket imports:
```
export interface PermissionRelay {
	readWriteClientCount(): number;
	raise(ask: RelayAsk): Promise<RelayAnswer | undefined>;
	withdraw(requestId: string, decidedBy: RelayDecider): void;
}
```
with `RelayAsk` = `{ requestId: string; method: "confirm" | "select" | "input"; title: string; message?: string; detail?: PermissionAskDetail; options: readonly { id: string; label: string }[]; requestedAt: string; deadline: string | null }`, `RelayAnswer` = `{ requestId: string; optionId: string; decidedBy: RelayDecider }`, `RelayDecider` = `{ surface: "tui" | "attach" | "rpc" | "acp" | "system"; clientId: string | null }`.

(4) NEW packages/coding-agent/src/core/permission-relay/relay-ui-context.ts — `export function createRelayUIContext(base: ExtensionUIContext, relay: PermissionRelay, baseIsLive: boolean): ExtensionUIContext`.
- Decorate EXACTLY `confirm`, `select`, `input`. HAND-DELEGATE every other member (~25) verbatim. DO NOT use a Proxy: `getEditorText`, `theme`, `getAllThemes`, `getTheme`, `getToolsExpanded`, `getEditorComponent` are synchronous and must return the base's local state, and `setWidget`/`setFooter`/`setHeader`/`custom` take component factories that cannot be serialized. `editor` and `custom` stay purely local by documented exception.
- `hasAnswerSurface()` = `baseIsLive || relay.readWriteClientCount() > 0`, evaluated LIVE on every call. `baseIsLive` is passed in — the caller in agent-session.ts knows whether the mode bound a real context.
- RACING CONTRACT, in this EXACT order (getting it wrong silently loses the winner):
  a. Mint `requestId` with `crypto.randomUUID()`. Create one `AbortController` for this ask.
  b. Start BOTH `base.<method>(..., { ...opts, signal: controller.signal })` and `relay.raise(ask)`.
  c. `settle(decider, optionId)` must be SYNCHRONOUS from the settled-check through resolving the outer promise — NO `await` anywhere between checking `settled` and setting `settled = true`. One await there lets both answers pass and produces two conflicting resolutions with no error (the second resolve() is a silent no-op).
  d. Order after a winner: mark settled -> resolve the outer promise -> THEN `controller.abort()` -> THEN `relay.withdraw(requestId, decider)`. Aborting BEFORE settling is a real defect: interactive mode honours `opts.signal` (packages/coding-agent/src/modes/interactive/interactive-mode.ts:2253-2262) by resolving its selector to `undefined`, which `showExtensionConfirm` maps to `false` at :2307 — so an abort-first implementation feeds a FABRICATED TUI DENY back through the decorator and overwrites a remote approve.
  e. Late results and late REJECTIONS from the losing side must be swallowed against a settled ask. An unswallowed rejection is fatal under Node's default `--unhandled-rejections=throw`.
  f. If `relay.readWriteClientCount() === 0` and `baseIsLive` is false, do NOT ask anyone: return the base's value immediately so the caller's fail-closed branch still fires.

(5) NEW packages/coding-agent/src/core/permission-relay/index.ts — a barrel re-exporting the two files above, plus a tiny exported no-op base context (confirm -> false, select/input -> undefined, everything else a no-op) for use when a mode bound none.

(6) packages/coding-agent/src/core/agent-session.ts:
- Add `private _permissionRelay?: PermissionRelay;` beside `_extensionUIContext` (around :358).
- Add a public `setPermissionRelay(relay: PermissionRelay | undefined): void` that stores it AND re-invokes `this._applyExtensionBindings(this._extensionRunner)`. The re-invoke is required: the constructor's apply (:401 -> :2642) has already run before any caller can hand a relay over.
- At :2360 pass a wrapped context when a relay is present: `runner.setUIContext(this._wrapUIContext(this._extensionUIContext), this._extensionMode)`, where a new private `_wrapUIContext(base)` returns `base` untouched when `this._permissionRelay` is undefined, and otherwise `createRelayUIContext(base ?? noOpBaseForRelay, this._permissionRelay, base !== undefined)`. Use the no-op base exported from the permission-relay barrel; `noOpUIContext` in runner.ts is module-private.
- Do NOT touch `bindExtensions` (:2281-2284). For the record it already guards with `if (bindings.uiContext !== undefined)`, so print mode does not clobber anything — do not 'fix' that.

DO NOT touch packages/coding-agent/src/main.ts, packages/coding-agent/src/core/builtins/subagent.ts, or anything under src/core/socket-server/ — other tasks own those.

THE TEST (`packages/coding-agent/test/relay-ui-context-surface.test.ts`, vitest). Class 2, in-process, with a hand-written fake `PermissionRelay` and a spy base context:
- Zero clients + no-op base: a session with `setPermissionRelay(fakeWithZeroClients)` leaves `runner.hasUI()` FALSE. This is the guard against fabricating "User denied approval".
- One client: `readWriteClientCount()` returning 1 makes `hasUI()` TRUE, evaluated LIVE (flip the count between two reads of the same context object and assert both answers).
- Remote wins: relay resolves first -> the returned value is the remote answer, the base's AbortSignal fired, and a LATE base resolution of `false` does NOT change the result.
- Abort-echo ordering: assert `withdraw()` was called AFTER the outer promise settled and the recorded decider is the remote one, never the abort-induced local `false`.
- Local wins: base resolves first -> `withdraw(requestId, {surface:"tui"})` called exactly once.
- Non-decorated members: assert `getEditorText`, `theme` and `setWidget` reach the base spy, proving hand-delegation rather than a Proxy.
- A late REJECTION from the losing side produces no unhandled rejection (register a `process.on("unhandledRejection")` guard and assert it never fires).

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && npx vitest --run test/relay-ui-context-surface.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/extensions/runner.ts packages/coding-agent/src/core/extensions/types.ts packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/core/permission-relay/types.ts packages/coding-agent/src/core/permission-relay/relay-ui-context.ts packages/coding-agent/src/core/permission-relay/index.ts packages/coding-agent/test/relay-ui-context-surface.test.ts

### T5 — The gate asks with canonical detail, and the RPC public protocol carries it

- **Wave** 2 · **Requirement** R34-PERM.3 · **Evidence class** 3 · **Depends on** T1, T2, T4
- **Files** `packages/coding-agent/src/core/builtins/subagent.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`, `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `packages/coding-agent/test/permission-detail-rpc.e2e.test.ts`
- **Test** `packages/coding-agent/test/permission-detail-rpc.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. Every tool permission prompt in the whole product comes from ONE line: packages/coding-agent/src/core/builtins/subagent.ts:605, `const approved = await ctx.ui.confirm("Approve tool call?", `${event.toolName}: ${decision.reason}`);` — a prose SUMMARY SENTENCE, with no third `opts` argument. It sits inside `createPermissionGateToolCallHandler` (:591-613), registered as an always-loaded core builtin at :882-886. At that line `event.toolCallId`, `event.input` (for bash: `{ command, timeout }`) and `ctx.cwd` are ALL in scope and ALL discarded. R34-PERM.3 forbids the summary sentence.

PREREQUISITES ALREADY LANDED (do not re-add): `ExtensionUIDialogOptions.detail?: PermissionAskDetail` and the exported `PermissionAskDetail` type in packages/coding-agent/src/core/extensions/types.ts; `boundedSafeText(raw, maxGraphemes)` returning `{ value, truncated, originalLength }` in packages/coding-agent/src/core/socket-server/safe-text.ts; `DRAHT_STUB_TOOL_CALLS` on the stub provider.

WHAT TO BUILD.

(1) packages/coding-agent/src/core/builtins/subagent.ts, inside `createPermissionGateToolCallHandler` only:
- Replace the two-branch `approve` handling at :601-609 with THREE branches: `ctx.hasUI === false` still returns today's `{ block: true, reason: `${decision.reason} (no UI available to request approval)` }` VERBATIM (that string is asserted elsewhere and is operator-facing — do not reword it); otherwise raise a structured ask; a negative answer still returns `{ block: true, reason: "User denied approval" }`.
- Build the ask as `ctx.ui.confirm("Approve tool call?", `${event.toolName}: ${decision.reason}`, { detail })` — keep both positional strings unchanged so every current renderer keeps working — where `detail` is a `PermissionAskDetail` carrying `kind: "tool_permission"`, `toolCallId: event.toolCallId`, `toolName: event.toolName`, the CANONICAL cwd, `command`/`path`/`operation` extracted from `event.input`, `reason: decision.reason`, and the FROZEN offered set `Object.freeze([{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }])`.
- Canonical cwd: `ctx.cwd` is the raw un-normalised `config.cwd`. Resolve it with `canonicalizePath` from packages/coding-agent/src/utils/paths.ts:28 (realpathSync with a safe fallback) so a symlinked worktree does not read as the wrong project.
- Extraction: prefer `input.command` (bash), else `input.file_path ?? input.path` (read/write/edit/grep/find/ls). For a tool with neither — every extension tool has `input: Record<string, unknown>` — set `operation` to a JSON serialization of the whole argument object. Never leave the detail empty.
- EVERY string field of `detail` must pass through `boundedSafeText(..., 512)` and carry only the `.value`. Do it here, at construction, because three renderers inherit it. Import from `../socket-server/safe-text.js` (match this file's existing .js-suffixed import style).

(2) packages/coding-agent/src/modes/rpc/rpc-types.ts: extend the `confirm` and `select` members of `RpcExtensionUIRequest` (:238-269) with an optional `detail?: RpcPermissionDetail`, and declare `RpcPermissionDetail` in THIS file as a structural mirror of `PermissionAskDetail` (do NOT import the coding-agent core type — this file is a protocol declaration). Extend `RpcExtensionUIResponse` (:280-283) with an optional `optionId?: string` on the `{ id, confirmed }` member so an answer can name the option it chose.

(3) packages/coding-agent/src/modes/rpc/rpc-mode.ts: in the module-local `createExtensionUIContext` (:158), thread `opts?.detail` into the emitted request for `confirm` and `select` (the request object is spread into the emitted frame at :151). Do NOT change `createDialogPromise`'s timeout/abort/cancel semantics (:113-153, :96-105); `confirm`'s fail-closed `defaultValue: false` at :164-167 must stay.

THE TEST (`packages/coding-agent/test/permission-detail-rpc.e2e.test.ts`, vitest). EVIDENCE CLASS 3 — it drives the EMITTED BINARY over its PUBLIC RPC PROTOCOL, never an in-process session:
- Build first: `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build`.
- Spawn `node /Users/exe008/draht/draht-mono/packages/coding-agent/dist/cli.js --provider draht-stub --model stub-1 --mode rpc` with stdio pipes. Environment: copy `process.env`, DELETE `DRAHT_PERMISSION_MODE` (this repo's shell exports `auto`, which would let the call through with no prompt and make the test vacuous), set `DRAHT_STUB_PROVIDER=1`, set `DRAHT_STUB_TOOL_CALLS` to script one `bash` call whose `command` is a long distinctive string ending in a decisive tail (e.g. `echo start && <200 chars of filler> && echo TAIL-MARKER`), and set `DRAHT_CODING_AGENT_DIR` to a short directory directly under `/tmp`.
- Send a `prompt` RPC command on stdin; read newline-delimited JSON off stdout until a `{"type":"extension_ui_request","method":"confirm"}` line arrives.
- ASSERT on that frame: `detail.toolCallId` is non-empty and matches the tool call id the same stream reported; `detail.toolName === "bash"`; `detail.cwd` equals `realpathSync` of the session cwd; `detail.command` CONTAINS `TAIL-MARKER` (proves tail-preserving bounding, not head truncation); `detail.options` is exactly the approve/deny pair; and `detail.command` is NOT the legacy summary sentence `bash: <reason>`.
- Answer on stdin with `{"type":"extension_ui_response","id":<id>,"confirmed":true,"optionId":"approve"}` and assert the tool then RAN (marker file on disk).
- Explicit timeout of at least 60000ms. Kill the child in a `finally`.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && env -u DRAHT_PERMISSION_MODE npx vitest --run test/permission-detail-rpc.e2e.test.ts`

Do not touch any file outside the four listed above; in particular do not touch interactive-mode.ts or anything under src/core/socket-server/ other than importing safe-text.

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/builtins/subagent.ts packages/coding-agent/src/modes/rpc/rpc-mode.ts packages/coding-agent/src/modes/rpc/rpc-types.ts packages/coding-agent/test/permission-detail-rpc.e2e.test.ts

### T6 — The permission frame train: one atomic socket-wire + geist-wire + corpus change

- **Wave** 2 · **Requirement** R34-PERM.1 · **Evidence class** 3 · **Depends on** T2
- **Files** `packages/coding-agent/src/core/socket-server/types.ts`, `packages/coding-agent/src/core/socket-server/socket-server.ts`, `packages/coding-agent/src/core/socket-server/socket-client.ts`, `packages/geist-protocol/src/wire.ts`, `packages/geist-protocol/test/wire-auth-frames.test.ts`, `packages/geist-protocol/conformance/MIGRATIONS.md`, `packages/geist-protocol/conformance/geist-0.3/`, `packages/geist-core/src/attach/attach-bridge.ts`, `scripts/check-geist-protocol.mjs`, `scripts/geist-conformance/socket-daemon.mjs`, `scripts/geist-conformance/record.mjs`, `scripts/geist-conformance/reference-daemon.mjs`, `packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. This is ONE ATOMIC CHANGE, not a sequence — three build gates make any split fail, and a wrong landing order disconnects every attached phone.

Two wires in series. (a) The SOCKET WIRE inside the draht process: newline-delimited JSON, declared entirely in packages/coding-agent/src/core/socket-server/types.ts — `ClientMessage = AttachMessage | InputMessage | DetachMessage` (:12) and a 6-member `ServerMessage` (:15-21). No version field, no handshake, no request/response pair, no correlation id. (b) The GEIST WIRE, `geist/0.x` member `"0.2"` at packages/geist-protocol/src/wire.ts:45, 6 client + 10 server frames in the two discriminated unions at wire.ts:336-343 and :346-358. packages/geist-core/src/attach/attach-bridge.ts is a decode-and-re-encode RE-FRAME between them, never a byte proxy.

MEASURED FACTS to design against:
- A socket-wire frame geist-protocol does not declare KILLS the renderer: `#onSessionData` (attach-bridge.ts:699-720) refuses the whole connection with `protocol_error` code `unknown_type` and closes 1008. geist-protocol must DECLARE the frames in the same change the socket wire gains them.
- The reverse skew is SILENT: `#handleClientMessage` (socket-server.ts:454-529) has NO default case, so an unknown client message vanishes with no reply.
- `mode` is NOT validated on attach: `mode:"banana"` is accepted today and its input reaches the session, because the check at socket-server.ts:502 is a negative `=== "read-only"` test.
- Zod strips unknown fields, so nothing can ride along on an existing frame; and `#fit` (attach-bridge.ts:732-736) splits ONLY `output`, so any other oversized frame trips the 64 KiB cap instead of being chunked.

THE THREE BUILD GATES (baseline: `bun /Users/exe008/draht/draht-mono/scripts/check-geist-protocol.mjs` is green today at '16 message type(s), 9 socket mirror(s), corpus geist/0.2'): `MIRRORED_UNIONS` (scripts/check-geist-protocol.mjs:94, failure text :253-254) fails on ANY ClientMessage/ServerMessage member without a geist mirror; `missingGoldens` (scripts/generate-geist-conformance.mjs:159-169) fails on any declared type with no recorded golden per direction; `hasMigrationNote` (:218-221) fails without a `## geist/0.3` heading in conformance/MIGRATIONS.md.

WHAT TO BUILD.

(1) packages/coding-agent/src/core/socket-server/types.ts:
- Add to `ClientMessage`: `PermissionResponseMessage { type: "permission_response"; clientId: string; requestId: string; optionId: string }`.
- Add to `ServerMessage`: `PermissionRequestMessage { type: "permission_request"; requestId: string; method: "confirm" | "select" | "input"; toolCallId: string; toolName: string; cwd: string; title: string; message: string; command?: string; path?: string; operation?: string; truncated: boolean; options: PermissionOption[]; requestedAt: string; deadline: string | null }` and `PermissionResolvedMessage { type: "permission_resolved"; requestId: string; decision: "approved" | "denied" | "cancelled" | "expired"; chosenOptionId: string | null; surface: string; clientId: string | null }`, with `PermissionOption { id: string; label: string }`.
- Add ONE optional field to `AttachMessage` (:24-28): `capabilities?: string[]`. This is the skew story — the server sends permission frames only to clients that declared `"permission-relay"`, so an OLD geist-core bridge (whose attach line lacks it) is never dropped with close 1008.
- Use only primitives, literals, string unions and flat object types — the gate's schema-shape parser compares this file field-for-field against the zod mirror.

(2) packages/coding-agent/src/core/socket-server/socket-server.ts (PLUMBING ONLY — no pending-registry policy; a later task owns that):
- `case "permission_response"`: reject when the client is unknown, read-only, or did not declare the capability, with a targeted error frame; otherwise forward to a new `onPermissionResponse((msg, clientId) => void)` registered the way `onInput` is. With no callback registered, reply with an `error` frame code `PERMISSION_UNKNOWN_REQUEST` — a refusal must never be silence.
- Add a `default:` case answering an unknown client message type with `{ type: "error", code: "UNKNOWN_MESSAGE_TYPE" }`.
- Validate `message.mode` on attach against the closed `ClientMode` set; refuse and end the socket otherwise. Record `capabilities` on `ConnectedClient` (types.ts:86-91).
- Add `sendPermissionRequest(clientId, msg)`, `broadcastPermissionRequest(msg)` (both skipping read-only and non-capable clients) and `broadcastPermissionResolved(msg)`. Today the only outbound API is `broadcastOutput` (:275), `broadcastError` (:287) and `sendErrorToClient` (:295).
- Add an `onAttachReplay((clientId) => void)` hook fired immediately AFTER `session_metadata` is sent (:481-487). Leave it unused here; a later task fills it.

(3) packages/coding-agent/src/core/socket-server/socket-client.ts: add the two new server cases to `#handleServerMessage` (:188-226) with `onPermissionRequest` / `onPermissionResolved` callbacks, add `sendPermissionResponse()` alongside `sendInput` (:100-111), and send `capabilities: ["permission-relay"]` in the attach frame.

(4) packages/geist-protocol/src/wire.ts:
- Bump `GEIST_PROTOCOL_VERSION` from `"0.2"` to `"0.3"` (:45).
- Declare `PermissionRequestFrameSchema`, `PermissionResolvedFrameSchema` (server) and `PermissionResponseFrameSchema` (client) as field-for-field mirrors of the socket messages, and add them to `ServerFrameSchema` (:346-358) / `ClientFrameSchema` (:336-343). `CLIENT_FRAME_TYPES`/`SERVER_FRAME_TYPES` (:369-375) derive automatically.
- Add `capabilities: z.array(z.string()).optional()` to `AttachFrameSchema` (:107-112).
- Enforce R34-PERM.4 at the boundary with `.refine()` on every free-text field of the permission frames — NEVER `.transform()`: a transform changes inferred types and makes decode/encode non-idempotent, and the conformance goldens compare byte-wise. This package must keep ZERO `@draht/*` dependencies, so hand-mirror the forbidden set from `NEUTRALIZED_FORBIDDEN_RANGES` in packages/coding-agent/src/core/socket-server/safe-text.ts, with a comment naming that file as the source of truth.
- Keep these frames small by construction: give the free-text fields `.max(...)` bounds well under the 64 KiB `maxFrameBytes` cap.

(5) packages/geist-protocol/test/wire-auth-frames.test.ts:100 is the ONE hard literal pin — `expect(GEIST_PROTOCOL_VERSION).toBe("0.2")`. Change it to `"0.3"`. Everything else imports the constant and follows automatically.

(6) packages/geist-protocol/conformance/MIGRATIONS.md: add a `## geist/0.3` section ABOVE the 0.2 one, following the file's 3-step ritual (see MIGRATIONS.md:10-19).

(7) scripts/check-geist-protocol.mjs: add one `MIRRORED_FRAMES` row per new relayed frame (table at :78-88), with the closed `added` list for any field the geist wire adds on purpose (the existing `AttachFrameSchema` row's `added: ["sessionId"]` is the pattern).

(8) Recorder: scripts/geist-conformance/socket-daemon.mjs today accepts exactly two stdin control commands, `output` and `stop` (:51-55; contract comment at :12-16). Add `permission_request` (broadcast a fixed ask) and `permission_resolved`. scripts/geist-conformance/reference-daemon.mjs must relay the new client->session frame. scripts/geist-conformance/record.mjs must script a deterministic ask/answer; add any non-deterministic field (requestId, requestedAt, deadline) to `NORMALIZED_FIELDS` at record.mjs:56-70 or byte-equality breaks on every run.

(9) Regenerate the corpus into the NEW directory: `cd /Users/exe008/draht/draht-mono && bun scripts/generate-geist-conformance.mjs`. `conformance/geist-0.1/` and `geist-0.2/` STAY COMMITTED. Never hand-author a golden. Then `bun scripts/check-geist-protocol.mjs` must print clean.

(10) packages/geist-core/src/attach/attach-bridge.ts: add `permission_response` to the client->session arm at :468-488, re-encoded with the server-pinned `this.#clientId` exactly as `input`/`detach` are at :479-481 — one client must never answer as another. Add `"permission-relay"` to the capabilities the bridge writes into its hand-built attach line at :680. In `#fit` (:732-736), add an explicit guard that a permission frame is small by construction and is REFUSED rather than split if it is not.

THE TEST (NEW packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3 — two real processes, `fetch` and a real `WebSocket` only. Copy the harness shape from the existing packages/gateway/src/__tests__/fleet-attach.e2e.test.ts (read its header: it forbids constructing an `AttachBridge` or a `net.Socket` in-test, and its `shortTempDir` helper explains the 104-byte sun_path limit). Build packages/coding-agent/dist/cli.js first with `bun run build`. Spawn the emitted draht binary with `--attachable` plus `bun packages/gateway/src/cli.ts` on an ephemeral loopback port, with `DRAHT_PERMISSION_MODE` DELETED from the child env and a short `/tmp` agent dir. Assert:
- `server_hello` now advertises family `geist/0.x` version `0.3`.
- A renderer sending `hello` with version `"0.2"` is refused with `protocol_error` code `version_mismatch`.
- After hello+attach at 0.3, a well-formed `permission_response` for an unknown requestId is NOT a protocol error and does NOT close the connection: the renderer receives an `error` frame with code `PERMISSION_UNKNOWN_REQUEST` and the socket stays open. This proves the whole client->session arm end to end.
- A genuinely unknown frame type still yields `protocol_error` `unknown_type`.
- The committed packages/geist-protocol/conformance/geist-0.3/ contains one golden per new type per direction (read the directory; do not regenerate inside the test).

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-frame-wire.e2e.test.ts`
Also run the gate once: `cd /Users/exe008/draht/draht-mono && bun scripts/check-geist-protocol.mjs`

DO NOT touch packages/coding-agent/src/core/socket-server/session-integration.ts, packages/coding-agent/src/main.ts, packages/geist-protocol/src/messages.ts, or root package.json — other owners.

Format when done, from /Users/exe008/draht/draht-mono (biome.json's `files.includes` covers only `packages/*/src/**` and `packages/*/test/**`, so the scripts/ and conformance/ paths are intentionally absent):
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/types.ts packages/coding-agent/src/core/socket-server/socket-server.ts packages/coding-agent/src/core/socket-server/socket-client.ts packages/geist-protocol/src/wire.ts packages/geist-protocol/test/wire-auth-frames.test.ts packages/geist-core/src/attach/attach-bridge.ts packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts

### T7 — TUI dialog: structured rows, a non-clobbering slot, and the deciding surface

- **Wave** 2 · **Requirement** R34-PERM.2 · **Evidence class** 2 · **Depends on** T2, T4
- **Files** `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/modes/interactive/components/extension-selector.ts`, `packages/coding-agent/test/interactive-permission-dialog.test.ts`
- **Test** `packages/coding-agent/test/interactive-permission-dialog.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. The local TUI permission dialog is `showExtensionConfirm` (packages/coding-agent/src/modes/interactive/interactive-mode.ts:2300-2308), which flattens everything into ONE string `${title}\n${message}` and hands it to `showExtensionSelector` (:2247-2285) -> `ExtensionSelectorComponent` (packages/coding-agent/src/modes/interactive/components/extension-selector.ts:47) -> `new Text(...)`, which preserves ANSI verbatim.

MEASURED DEFECTS on that path (each reproduced against the real component): a raw `ESC[2J` in an attacker-influenced command CLEARS the operator's screen; U+202E survives and reverses the rendering; a `\n` inside the command FABRICATES a convincing fake option list ABOVE the real one; and a 5000-character command renders 76 rows with the genuine `Yes` row at index 70 — off screen on any normal terminal.

Two further facts. `this.extensionSelector` is assigned UNCONDITIONALLY at :2264 without disposing or resolving whatever was there, so a second concurrent dialog strands the first promise forever. And — correcting a claim you may have heard — the TUI ALREADY has a working external-resolution path: `opts.signal` is honoured (aborted-check at :2251, abort listener at :2259-2262 tearing the selector down and resolving `undefined`, mapped to `false` at :2307). What is missing is only the DECIDING-SURFACE rendering, not the dismissal mechanism.

PREREQUISITES ALREADY LANDED: `ExtensionUIDialogOptions.detail?: PermissionAskDetail` in packages/coding-agent/src/core/extensions/types.ts; `boundedSafeText(raw, maxGraphemes)` in packages/coding-agent/src/core/socket-server/safe-text.ts.

WHAT TO BUILD.

(1) packages/coding-agent/src/modes/interactive/components/extension-selector.ts: accept an optional array of pre-rendered DETAIL ROWS (`readonly string[]`) instead of relying on the caller to embed newlines in the title, and cap how many rows of title+detail it will draw (a hard `MAX_DETAIL_ROWS`, e.g. 12, with a `… +N more` row) so the option list can NEVER be pushed off screen. Do not change its option-selection keybindings or its `onToggleToolsExpanded` behaviour.

(2) packages/coding-agent/src/modes/interactive/interactive-mode.ts:
- When `opts?.detail` is present, `showExtensionConfirm` must build STRUCTURED ROWS from the typed fields (tool, cwd, command/path/operation, reason) rather than concatenating `${title}\n${message}`. Each row's text passes through `boundedSafeText(..., N)` sized to the current terminal width before it reaches `new Text(...)`. The protocol layer already neutralizes what arrives from a remote surface, but a LOCALLY raised ask never crosses the wire, so the TUI must apply the same rule itself. Import from `../../core/socket-server/safe-text.js` (match the file's existing .js-suffixed import style).
- Stop treating `visibleWidth` (packages/tui/src/utils.ts:249) as a safety property: it strips ANSI for MEASUREMENT only and reports 0 for bidi and DEL, so padding math over an unneutralized string is meaningless. Neutralize first, measure second.
- Fix the clobberable slot at :2264: if `this.extensionSelector` is already set, resolve the outstanding promise as cancelled and dispose the old component before installing the new one. Never leave a promise stranded — a stranded one wedges the agent loop inside `beforeToolCall`.
- Add a way for the dialog to report that it was resolved ELSEWHERE. When the abort listener fires (:2259-2262), tear the dialog down AND render a one-line notice through the existing notification path saying which surface decided, using an optional `decidedBy` label the caller sets on the ask before aborting. Expose it as a small method (e.g. `noteExtensionDialogResolvedElsewhere(label: string)`) the relay's withdraw path can call; do not build a new event bus.

DO NOT touch packages/coding-agent/src/core/permission-relay/*, subagent.ts, or anything under src/core/socket-server/ except importing safe-text.

THE TEST (`packages/coding-agent/test/interactive-permission-dialog.test.ts`, vitest). EVIDENCE CLASS 2 — the TUI is not reachable from a Class-3 harness without a PTY, which is out of scope here. Construct the real `ExtensionSelectorComponent` (after `initTheme("dark")`, as other TUI tests in this package do) and assert over its rendered lines:
- A detail row containing `[2J[H` renders with NO raw ESC byte in any output line.
- A detail row containing U+202E renders with no U+202A-U+202E in any output line.
- A 5000-character command produces a bounded number of rows and the option rows (`Yes`, `No`) appear within the first `MAX_DETAIL_ROWS + 4` lines — write the expected index bound literally.
- A command containing `\nYes\nNo` does not produce two extra rows that look like options (assert the count of option-looking rows).
- Two overlapping `showExtensionConfirm` calls: the first promise SETTLES (does not hang) when the second dialog opens.
- Aborting via `opts.signal` still resolves the confirm to `false` (unchanged) and the deciding-surface notice was emitted exactly once.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && npx vitest --run test/interactive-permission-dialog.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/src/modes/interactive/components/extension-selector.ts packages/coding-agent/test/interactive-permission-dialog.test.ts

### T8 — The relay: pending registry, fan-out, first-answer-wins, resolution echo, JSONL record

- **Wave** 3 · **Requirement** R34-PERM.2 · **Evidence class** 3 · **Depends on** T3, T4, T5, T6
- **Files** `packages/coding-agent/src/core/socket-server/permission-registry.ts`, `packages/coding-agent/src/core/socket-server/permission-delivery.ts`, `packages/coding-agent/src/core/socket-server/permission-relay.ts`, `packages/coding-agent/src/core/socket-server/session-integration.ts`, `packages/coding-agent/src/core/socket-server/index.ts`, `packages/coding-agent/src/main.ts`, `packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. This task closes the loop: a permission ask raised by the agent reaches an attached client as a real frame, the client's answer comes back out of band, the first valid answer wins, and the resolution is recorded in the session JSONL and echoed to every other surface.

WHAT ALREADY EXISTS (do not rebuild):
- `PermissionRelay` / `RelayAsk` / `RelayAnswer` / `RelayDecider` ports in packages/coding-agent/src/core/permission-relay/types.ts, and `createRelayUIContext` decorating confirm/select/input. `AgentSession.setPermissionRelay(relay)` exists and re-invokes `_applyExtensionBindings` itself.
- Socket wire frames `permission_request`, `permission_resolved`, `permission_response`, an attach-time `capabilities` field, `SocketServer.onPermissionResponse(...)`, `sendPermissionRequest`/`broadcastPermissionRequest`/`broadcastPermissionResolved`, and an `onAttachReplay(clientId)` hook fired right after `session_metadata` — all in packages/coding-agent/src/core/socket-server/socket-server.ts.
- `SessionManager.appendPermissionResolution(...)` and the `PermissionResolutionEntry` variant in packages/coding-agent/src/core/session-manager.ts.
- `boundedSafeText(raw, maxGraphemes)` in packages/coding-agent/src/core/socket-server/safe-text.ts.

WHAT TO BUILD.

(1) NEW packages/coding-agent/src/core/socket-server/permission-registry.ts — the bounded pending registry, PURE (no socket or session imports beyond types). One entry per ask, keyed by `(sessionId, requestId)` with `requestId` minted by `crypto.randomUUID()` — never a per-session counter, because forks copy entries verbatim (session-manager.ts:1435-1443) and counters collide across sessions. Each entry stores the IMMUTABLE offered-option set (`Object.freeze`), the canonical detail, `requestedAt`, the registry deadline, and a state: `PENDING -> RESOLVED | EXPIRED | CANCELLED`. Bounds: a max entry count (precedent: `maxClients` 10 at socket-server.ts:119), a max serialized byte size, and a wall-clock deadline. Export `settle(sessionId, requestId, optionId, decidedBy)` which is SYNCHRONOUS from validation through the compare-and-swap: check PENDING, validate `optionId` against the frozen set, mark RESOLVED, remove, then hand the caller the resolver to run. NO `await` between the pending-check and the mark. Keep a short-TTL RESOLVED TOMBSTONE so a late answer gets `already resolved by <surface>` rather than a bare unknown-id refusal. Every refusal path (unknown id, stale id, cross-session id, invalid option) returns a REFUSAL VALUE and leaves the entry untouched and still answerable — refusal must never resolve the promise, never fire the deadline, and never touch the caller's connection.

(2) NEW packages/coding-agent/src/core/socket-server/permission-delivery.ts — per-connection delivery bookkeeping, kept STRICTLY SEPARATE from entry state. A `deliveredTo` set per clientId, reset when that client disconnects. `pendingFor(clientId)` returns every still-PENDING ask that client has not been shown. Delivery and acknowledgement must NEVER be a state transition on the entry: if sending consumed the ask, a client that acked and then died would lose it forever while the agent sits parked in `beforeToolCall`.

(3) NEW packages/coding-agent/src/core/socket-server/permission-relay.ts — `createSocketPermissionRelay({ registry, delivery, server, sessionManagerRef, sessionIdRef })` returning an object implementing `PermissionRelay`:
- `readWriteClientCount()` counts attached clients that are read-write AND declared the `permission-relay` capability.
- `raise(ask)`: build the `permission_request` frame with EVERY free-text field already passed through `boundedSafeText(..., N)` and `truncated` set from its result; INSERT THE ENTRY INTO THE REGISTRY SYNCHRONOUSLY BEFORE THE FIRST SOCKET WRITE (otherwise an answer can arrive referencing an id the registry has never seen), then fan out to every eligible client; return a promise resolved by `settle`.
- On a winning answer, run this EXACT ORDER: settle -> resolve the raise() promise -> broadcast `permission_resolved` to every client -> `appendPermissionResolution(...)` on the session's SessionManager. `AgentSession.sessionManager` is public and mutable (agent-session.ts:309), so the relay can append; extensions cannot.
- `withdraw(requestId, decidedBy)`: the LOCAL surface won — settle the entry as resolved-elsewhere, broadcast `permission_resolved`, append the JSONL record with that decider.
- Record EVERY terminal state — approved, denied, cancelled, expired — never only the happy path.

(4) packages/coding-agent/src/core/socket-server/session-integration.ts:
- Build the registry/delivery/relay inside the `bind` closure (:75-137) so they DIE WITH THE SESSION but SURVIVE client churn (`#handleClientDisconnect` at socket-server.ts:535-547 only deletes the client). Expose the relay on the returned `AttachableSession` as a new `readonly relay: PermissionRelay | null` member, extending the `AttachableSession` interface (:34-46) and `DISABLED_SESSION` (:48-54).
- Wire `next.onPermissionResponse(...)` to the registry. CRITICAL: this path must NOT go through `next.onInput(...)` at :94 — that funnels every inbound byte into `session.prompt(data, { streamingBehavior: "followUp" })` at :118, which is exactly why answering "Yes" from a phone is swallowed as a queued prompt today. Leave the `onInput` block otherwise untouched, including its PROMPT_QUEUED reporting.
- Wire `next.onAttachReplay(clientId)` to push `delivery.pendingFor(clientId)` once.
- In `rebind` (:151-180), CANCEL every pending ask fail-closed before the old server is stopped, then build a fresh registry for the new session. In `stop`/`stopSync` (:181-200), cancel fail-closed too.

(5) packages/coding-agent/src/main.ts:
- Immediately after `attachableSession = await makeSessionAttachable({...})` succeeds (main.ts:914-921) and BEFORE the mode dispatch at :941, call `session.setPermissionRelay(attachableSession.relay ?? undefined)`.
- Inside the EXISTING `runtime.addSessionReplacedListener` at :935-938, after `await attachableSession.rebind(nextSession, ...)`, re-hand the relay: `nextSession.setPermissionRelay(attachableSession.relay ?? undefined)`. Without this the relay silently dies on /new, /resume, /fork and /import.
- Change nothing else in main.ts. Do NOT install the decorator here — `bindExtensions` runs later and the wrap belongs at agent-session.ts:2360, which already handles it.

(6) packages/coding-agent/src/core/socket-server/index.ts — re-export the new modules from the barrel.

THE TEST (NEW packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3 — copy the two-real-process harness shape and the `shortTempDir` helper from packages/gateway/src/__tests__/fleet-attach.e2e.test.ts (read its header first: it forbids constructing an `AttachBridge` or a `net.Socket` in-test). Build packages/coding-agent/dist/cli.js with `bun run build` first. Spawn the emitted draht binary with `--attachable --provider draht-stub --model stub-1` under a short `/tmp` agent dir, with `DRAHT_STUB_PROVIDER=1`, `DRAHT_STUB_TOOL_CALLS` scripting one `bash` call that writes a marker file, and `DRAHT_PERMISSION_MODE` DELETED from the child env. Spawn `bun packages/gateway/src/cli.ts` on an ephemeral loopback port. Then, over a REAL WebSocket to `/attach`:
- Assert a `permission_request` frame arrives carrying the matching `toolCallId`, the canonical `cwd`, the command text, and a two-member `options` array.
- Send `permission_response` with `optionId: "approve"`; assert a `permission_resolved` frame arrives with `decision: "approved"` and a `surface`/`clientId` naming the answering client.
- Assert the marker file EXISTS — the tool actually ran because the phone said so.
- Assert the session's own .jsonl file (find it under the temp agent dir) contains a `permission_resolution` line whose `requestId`, `toolCallId`, `decision` and `decidedBy` match. Scope this to a TOOL-CALL permission only: `_persist` (session-manager.ts:1029-1055) buffers everything until the first assistant message, and the assistant message carrying the tool call is persisted at `message_end` before any tool executes, so this is safe — a permission raised on turn 1 before any assistant message would not be.
- Give each test at least 90000ms.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-relay-roundtrip.e2e.test.ts`

Do not touch socket-server.ts, socket-server/types.ts, socket-client.ts, wire.ts, attach-mode.ts or interactive-mode.ts — other owners.

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/permission-registry.ts packages/coding-agent/src/core/socket-server/permission-delivery.ts packages/coding-agent/src/core/socket-server/permission-relay.ts packages/coding-agent/src/core/socket-server/session-integration.ts packages/coding-agent/src/core/socket-server/index.ts packages/coding-agent/src/main.ts packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts

### T9 — Answers validated against the immutable offered-option set; refusals never consume

- **Wave** 4 · **Requirement** R34-PERM.5 · **Evidence class** 3 · **Depends on** T8
- **Files** `packages/coding-agent/src/core/socket-server/permission-registry.ts`, `packages/gateway/src/__tests__/permission-answer-validation.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/permission-answer-validation.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. The pending registry exists at packages/coding-agent/src/core/socket-server/permission-registry.ts, the relay round-trips end to end, and packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts proves the happy path. This task hardens and PROVES the adversarial half of R34-PERM.5: unknown, stale and cross-session ids, and invalid option ids, are refused WITHOUT consuming a still-answerable request.

THREE IN-HOUSE PRECEDENTS FOR GETTING IT WRONG — read them, then make sure the registry does none of them:
- packages/geist-acp/src/acp-harness-session.ts:325-332 DELETES the pending entry and THEN resolves with a completely unvalidated `optionId` — a bogus option consumes a still-answerable request.
- packages/coding-agent/src/modes/rpc/rpc-mode.ts:856-859 gets on id, deletes, resolves — so a matching-id MALFORMED response consumes the ask and, via the confirm parser at :164-167, resolves it to `false`, i.e. a silent DENY.
- packages/geist-acp/src/acp-harness-session.ts:469-470 mints ids as a per-session counter `perm-${n}`, which collides trivially across sessions.

TWELVE WAYS TO ACCIDENTALLY CONSUME — audit the registry against every one and fix what you find: (1) delete-then-validate; (2) delete-on-id-match before option validation; (3) resolving with the negative default on an invalid answer (reusing the abort/timeout path); (4) routing refusal through any cancel-all sweep; (5) one-shot-resolver misuse — refusal must be a targeted wire error to the SENDER ONLY, resolver untouched; (6) teardown coupling — a client disconnect must NOT touch the registry (R34-PERM.6 forbids it), and the bridge's `#refuse` at packages/geist-core/src/attach/attach-bridge.ts:707-714 closes the whole WS on a schema-invalid answer; (7) validating OUTSIDE the compare-and-swap, so an invalid answer wins the CAS and then fails validation, leaving the request consumed with no decision; (8) cross-session/fork aliasing — key on `(sessionId, requestId)` with `crypto.randomUUID` ids; (9) mapping an unknown id onto 'the one pending ask' (tempting, because the gate serializes to at most one tool ask at a time via packages/agent/src/agent-loop.ts:507/:620 — catastrophic); (10) firing the withdraw AbortController on refusal, which resolves the local TUI dialog to `false` (interactive-mode.ts:2307) and leaks a deny; (11) treating an invalid answer as early expiry; (12) letting an unrecognized answer frame fall through into the prompt path.

WHAT TO CHANGE. Only packages/coding-agent/src/core/socket-server/permission-registry.ts. Make the ordering inside `settle` literally: find PENDING entry -> validate sessionId matches -> validate optionId is a member of the frozen offered set -> mark RESOLVED -> remove -> return the resolver, with NO `await` anywhere in that sequence and with every failure returning a typed refusal (`{ refused: "unknown_request" | "cross_session" | "invalid_option" | "already_resolved" }`) that leaves the entry exactly as it was. Do not change the delivery module, the relay, session-integration, or socket-server.

THE TEST (NEW packages/gateway/src/__tests__/permission-answer-validation.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3 — the adversarial answers must cross a REAL WebSocket. Copy the harness from packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts (same two real processes: the emitted packages/coding-agent/dist/cli.js `--attachable` built with `bun run build`, plus `bun packages/gateway/src/cli.ts`; short `/tmp` agent dir for the 104-byte sun_path limit; `DRAHT_PERMISSION_MODE` DELETED from the child env; `DRAHT_STUB_PROVIDER=1` and `DRAHT_STUB_TOOL_CALLS` scripting one bash call that writes a marker file).

Raise ONE ask, then, BEFORE answering it correctly, fire each of these over the same socket and assert BOTH the refusal AND non-consumption:
- unknown `requestId` -> targeted `error` frame; NO `permission_resolved` broadcast; connection stays open.
- an `optionId` not in the offered set (e.g. `"maybe"`) -> targeted `error`; no resolution.
- a `requestId` from a DIFFERENT session (spawn a second `--attachable` binary, capture its requestId, replay it here) -> targeted `error`; no resolution.
- a read-only attach answering -> refused at the socket layer; no resolution.
AFTER all four, send the VALID answer `optionId: "approve"` and assert it still wins: `permission_resolved` with `decision: "approved"` arrives and the marker file exists. That final assertion is the whole point — the request was still answerable.
Finally, replay the now-stale valid answer and assert the refusal names `already resolved` (the tombstone), not a bare unknown id.

Give each test at least 90000ms.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-answer-validation.e2e.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/permission-registry.ts packages/gateway/src/__tests__/permission-answer-validation.e2e.test.ts

### T10 — Bounded pending registry survives disconnect, replays exactly once, expiry fails closed

- **Wave** 4 · **Requirement** R34-PERM.6 · **Evidence class** 3 · **Depends on** T8
- **Files** `packages/coding-agent/src/core/socket-server/permission-delivery.ts`, `packages/coding-agent/src/core/socket-server/socket-server.ts`, `packages/gateway/src/__tests__/permission-durability.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/permission-durability.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. R34-PERM.6 asks for a bounded pending registry that survives client disconnect, replays exactly once after an authenticated reconnect, fails closed on expiry, and removes entries on answer, cancel or session exit.

MEASURED BASELINE: nothing survives a disconnect today. Running a real `SocketServer`, a client that dropped and reattached with the SAME clientId received exactly one frame — `session_metadata` — and everything broadcast while it was away was gone. `#handleClientDisconnect` (packages/coding-agent/src/core/socket-server/socket-server.ts:535-547) deletes the client and keeps nothing, and `AttachBridge` is rebuilt per WebSocket connection, so geist-core keeps nothing either. The registry cannot live in geist-core at all: scripts/check-geist-boundary.mjs forbids `@draht/coding-agent` imports there.

WHAT ALREADY EXISTS: packages/coding-agent/src/core/socket-server/permission-delivery.ts (per-connection `deliveredTo` bookkeeping, `pendingFor(clientId)`), the `PENDING -> RESOLVED | EXPIRED | CANCELLED` machine in permission-registry.ts, `SocketServer.onAttachReplay(clientId)` fired right after `session_metadata` (around socket-server.ts:481-487), and cancellation on rebind/stop already wired in session-integration.ts.

WHAT TO BUILD.

(1) packages/coding-agent/src/core/socket-server/permission-delivery.ts:
- Delivery bookkeeping is PER CONNECTION and RESET when that connection drops, so a reconnecting client is replayed. Never let delivery state persist across reconnects in a way that suppresses replay.
- Delivery and acknowledgement must NEVER be a state transition on the entry. If sending or acking consumed the ask, a client that acked and then died would lose it permanently while the agent sits parked in `beforeToolCall` forever — the exact wedge documented at packages/coding-agent/src/modes/rpc/rpc-mode.ts:85-96. A client that acked-then-died simply gets the same PENDING ask replayed on its next attach.
- 'Exactly once' means precisely two things, and a code comment must say so: exactly ONE authoritative resolution per request (the registry's compare-and-swap), and exactly ONE replay per (reconnect, still-pending request), deduplicated client-side by `requestId`. True end-to-end exactly-once is impossible over this wire and must not be attempted.
- Bound the replay: cap how many pending asks are pushed on one attach and cap total serialized bytes.
- Expiry FAILS CLOSED: when the registry's wall-clock deadline elapses, the entry becomes EXPIRED, the raise() promise resolves to the negative default (never an approval), a `permission_resolved` with `decision: "expired"` is broadcast, and the JSONL record is written. There is ONE clock: this registry deadline. The `deadline` field on the wire frame is ADVISORY RENDERING DATA — no client-side auto-deny, and the daemon must not enforce the frame's value. This follows the archived R34-PERM.8 measurement (the agent core imposes no deadline; 'hold the turn' is the primary mechanism), so an enforced frame deadline would be a NEW denial path.

(2) packages/coding-agent/src/core/socket-server/socket-server.ts:
- `#handleClientDisconnect` (:535-547) must NOT drop or touch any registry entry — only per-connection delivery state. Add a comment naming R34-PERM.6 so a later reader does not 'tidy' it.
- Ensure `onAttachReplay` fires after `session_metadata` on EVERY attach, including a reattach with a previously-seen clientId, and only for clients that are read-write and declared the `permission-relay` capability.
- Document the authentication answer rather than inventing one: on the local socket the authentication is filesystem-only (0o700 dir / 0o600 socket, socket-server.ts:136-167) with a self-asserted `clientId`; the device credential lives one hop up in the gateway's `/attach`. Put that in a comment on the replay path.

Do not touch permission-registry.ts, permission-relay.ts, session-integration.ts or main.ts — other owners.

THE TEST (NEW packages/gateway/src/__tests__/permission-durability.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3. Copy the two-real-process harness from packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts (emitted packages/coding-agent/dist/cli.js `--attachable`, built with `bun run build`; `bun packages/gateway/src/cli.ts`; short `/tmp` agent dir; `DRAHT_PERMISSION_MODE` DELETED from the child env; `DRAHT_STUB_PROVIDER=1` plus `DRAHT_STUB_TOOL_CALLS`). Assert:
- Raise an ask, receive the `permission_request`, then CLOSE the WebSocket without answering. Reopen a new WebSocket, handshake and attach: the still-pending ask is replayed exactly ONCE (count frames over a fixed settle window; assert 1). Answer it and assert the tool ran.
- Raise an ask while NO client is attached at all, then attach for the first time: the ask is delivered on attach.
- Attach twice in a row without answering: the second attach replays it again (a new connection is a new delivery), but a single connection never receives the same requestId twice.
- Expiry: configure a short registry deadline for this run (via an env knob you add, or by scripting a long-running ask), let it elapse, and assert a `permission_resolved` with `decision: "expired"` is broadcast, the tool did NOT run, and the session .jsonl carries a `permission_resolution` line with `decision: "expired"`.
- Answer an ask, then reconnect: the answered ask is NOT replayed, and replaying its stale answer yields an `already resolved` refusal (the tombstone), not a bare unknown-id error.

Give each test at least 90000ms.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-durability.e2e.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/permission-delivery.ts packages/coding-agent/src/core/socket-server/socket-server.ts packages/gateway/src/__tests__/permission-durability.e2e.test.ts

### T11 — Enumeration regression: every execution that raises a local prompt raises a remote one

- **Wave** 4 · **Requirement** R34-PERM.7 · **Evidence class** 3 · **Depends on** T1, T5, T8
- **Files** `packages/gateway/src/__tests__/permission-enumeration.e2e.test.ts`, `packages/gateway/src/__tests__/fixtures/permission-probe-extension.ts`
- **Test** `packages/gateway/src/__tests__/permission-enumeration.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. This task writes ONE test and one fixture. It changes NO product code. If the test exposes a genuine product gap, REPORT it — do not widen your file set to fix it.

WHAT MUST BE PROVEN. For every tool in draht's ACTIVE registry inside the running binary, an execution that would raise a LOCAL permission prompt also raises a REMOTE one over the attach wire.

SIX MEASURED OBSTACLES, each of which has already sunk a naive version of this test:
1. The oracle is ARGUMENT-DEPENDENT, not metadata-dependent. Measured under shipped defaults (mode `default`, no permissions.yml, cwd=/tmp/proj): `bash` always prompts; `read`/`write`/`edit` prompt only when `path` is outside cwd or missing; `grep`/`find`/`ls` prompt only when `path` is outside cwd (a missing path means cwd, which is allowed); `subagent` never prompts (it is in `DEFAULT_ALLOWED_TOOLS`, packages/coding-agent/src/core/multi-agent/permission-gate.ts:108); every extension tool and `duet_delegate` prompt on EVERY call via the catch-all at permission-gate.ts:755. A registry walk with one canned argument per tool asserts nothing for six of eight tools.
2. Computing the expectation from `PermissionGate.evaluate` is a TAUTOLOGY — it would keep passing if the gate stopped being wired at all. The expectation must be an OBSERVED frame, and the argument vectors and expected outcomes must be written LITERALLY in the test.
3. `DRAHT_PERMISSION_MODE` is inherited from the ambient environment and this repo's interactive shell exports `auto`. A harness that forgets to delete it passes while proving nothing. `yolo` downgrades every approve to allow, so a yolo run raises ZERO prompts.
4. The emitted binary cannot produce a tool call offline without `DRAHT_STUB_TOOL_CALLS` (added earlier in this phase to packages/coding-agent/src/extensions/stub-provider/provider.ts).
5. `--attachable` binds a Unix socket under `<agentDir>/sockets/`; an agent dir under `$TMPDIR` blows the 104-byte `sun_path` limit and fails with EINVAL on macOS. Use a short dir directly under `/tmp`.
6. There is no way to enumerate the tool registry over any public protocol — the RPC command set has no `get_tools` and the CLI has no `--list-tools`. The only honest hook is `pi.getAllTools()` from inside a loaded extension (declared at packages/coding-agent/src/core/extensions/types.ts:1366; used by packages/coding-agent/examples/extensions/tools.ts:40).

THE FIXTURE (NEW packages/gateway/src/__tests__/fixtures/permission-probe-extension.ts): a draht extension, loaded into the spawned binary with `-e <abs path>`, that on session start prints ONE machine-readable line to stderr, e.g. `PERMISSION_PROBE_TOOLS <json array of tool names>`, built from `pi.getAllTools()`. It must register nothing else. Model its shape on packages/coding-agent/examples/extensions/hello.ts.

THE TEST (NEW packages/gateway/src/__tests__/permission-enumeration.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3. Copy the two-real-process harness from packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts: the emitted packages/coding-agent/dist/cli.js (build first with `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build`) run with `--attachable --provider draht-stub --model stub-1 -e <packages/coding-agent/examples/extensions/hello.ts> -e <the probe fixture>`, plus `bun packages/gateway/src/cli.ts`, a short `/tmp` agent dir, `DRAHT_STUB_PROVIDER=1`, `DRAHT_STUB_TOOL_CALLS` scripting the calls, and `DRAHT_PERMISSION_MODE` DELETED from the child env. Note packages/coding-agent/examples/extensions/hello.ts is a real in-repo extension that ships in the binary's `examples/` and contributes an active tool named `hello`.

Structure:
- Read the probe line off the child's stderr to get the ACTIVE tool list from INSIDE the binary. It should include read, bash, edit, write, subagent, hello.
- Declare a LITERAL table in the test: one row per tool name, each with an APPROVE-VECTOR (arguments that must raise a prompt) and, where one exists, an ALLOW-VECTOR (arguments that must NOT). FAIL the test if any enumerated tool has no row — that is the enumeration's teeth: a newly added tool cannot slip past.
- For each approve-vector: script it via `DRAHT_STUB_TOOL_CALLS`, attach over a real WebSocket, assert EXACTLY ONE `permission_request` frame arrives with the matching `toolCallId` and canonical detail, answer it over the same socket, and assert the tool's side effect happened (a marker file).
- For each allow-vector: assert ZERO `permission_request` frames over a fixed settle window, and that the tool still ran.
- Include the extension-provided tool `hello` as an explicit approve-vector row — it is the case R34-PERM.7 names, and it is blocked headless under BOTH `default` AND `auto` today because permission-gate.ts:755 defaults unknown tools to `approve`.
- Give each test at least 120000ms.

EXPLICITLY OUT OF SCOPE, and you must say so in a comment at the top of the test rather than attempting it: the SUBAGENT leg. A subagent is a separate `draht --mode json -p --no-session` child process (packages/coding-agent/src/core/builtins/subagent.ts:241-266) spawned with no socket, no UI and no env channel back to the parent, so a tool call inside it raises NO prompt anywhere and hard-blocks. That is a product gap awaiting a scope ruling, not something this test can close.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-enumeration.e2e.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/gateway/src/__tests__/permission-enumeration.e2e.test.ts packages/gateway/src/__tests__/fixtures/permission-probe-extension.ts

### T12 — Class-3 closure for spoof-safe rendering: hostile payloads neutralized on the wire

- **Wave** 4 · **Requirement** R34-PERM.4 · **Evidence class** 3 · **Depends on** T2, T6, T8
- **Files** `packages/coding-agent/src/core/socket-server/safe-text.ts`, `packages/gateway/src/__tests__/permission-safe-text.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/permission-safe-text.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. packages/coding-agent/src/core/socket-server/safe-text.ts already implements `boundedSafeText(raw, maxGraphemes) -> { value, truncated, originalLength }` (NFC + surrogate repair, one-for-one visible-marker replacement of C0/DEL/C1/bidi/invisibles, grapheme-safe MIDDLE elision preserving the decisive tail) plus `isNeutralized()` and `NEUTRALIZED_FORBIDDEN_RANGES`, and it is applied where the permission frame is CONSTRUCTED. packages/geist-protocol/src/wire.ts re-asserts the invariant with a `.refine()` (never a `.transform()` — the conformance goldens compare byte-wise). This task PROVES it at Class 3 and fixes safe-text.ts if the proof exposes a hole. You own safe-text.ts for that purpose only; if a fix belongs elsewhere, REPORT it instead of widening your file set.

WHY THE PROTOCOL LAYER AND NOT THE RENDERERS. Three renderers consume this: the local TUI (`new Text(...)` preserves ANSI verbatim and treats CR/LF as row breaks), `draht --attach` (writes session bytes straight to the TTY, packages/coding-agent/src/cli/attach-mode.ts:99-105, over a wire it parses with a bare `JSON.parse(line) as ServerMessage` cast at packages/coding-agent/src/core/socket-server/socket-client.ts:177), and the geist-console web bundle (HTML-safe via `textContent` but fully bidi-transparent). Only construction-time neutralization covers all three — and `draht --attach` never passes through geist-protocol at all.

THE FOUR ATTACKS to prove closed:
A. TAIL ELISION — a shell command's decision-relevant content is its TAIL (chained segments after `;`/`&&`/`|`, redirections, trailing flags). Head-truncation deletes exactly that.
B. BIDI REVERSAL — U+202E costs ZERO display width in this codebase (`visibleWidth(U+202E) === 0`, packages/tui/src/utils.ts:249), so no width budget can price it out, and truncating inside an override run leaves it live over everything appended afterwards.
C. ESCAPE EXECUTION / ROW FABRICATION — a raw `ESC[2J` clears the operator's screen; a `\n` fabricates a fake option list.
D. UNBOUNDED LENGTH — measured at 76 rendered rows with the genuine `Yes` row at index 70 for a 5000-character command.

THE TEST (NEW packages/gateway/src/__tests__/permission-safe-text.e2e.test.ts, `bun:test`). EVIDENCE CLASS 3 — assert over bytes that crossed a REAL WebSocket, never over a call to `boundedSafeText`. Copy the two-real-process harness from packages/gateway/src/__tests__/permission-relay-roundtrip.e2e.test.ts: the emitted packages/coding-agent/dist/cli.js `--attachable --provider draht-stub --model stub-1` (build first with `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build`), plus `bun packages/gateway/src/cli.ts`, a short `/tmp` agent dir (104-byte sun_path limit), `DRAHT_STUB_PROVIDER=1`, and `DRAHT_PERMISSION_MODE` DELETED from the child env.

Drive a bash tool call via `DRAHT_STUB_TOOL_CALLS` whose `command` argument is a single hostile string combining ALL FOUR attacks: a leading `[2J[H`, an embedded `\r\nYes\r\nNo`, an unterminated `‮`, an embedded `rm -r\nf /`, ~5000 characters of filler, and a distinctive decisive TAIL such as `&& echo DECISIVE-TAIL-MARKER`. Capture the `permission_request` frame off the WebSocket and assert on the frame's OWN fields:
- The `command` field contains NO code point in the C0 range, no U+007F, no U+0080-U+009F, and none of U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069.
- It still contains `DECISIVE-TAIL-MARKER` — the tail survived.
- It contains an elision marker naming a NUMERIC count of elided characters (a bare `…` cannot distinguish 3 elided characters from 4000 of padding).
- `truncated === true` and `originalLength` is present and larger than the rendered length.
- No control character was DELETED: assert specifically that the embedded `rm -r\nf /` did not weld into `rm -rf /`.
- The whole frame is under the 64 KiB `maxFrameBytes` transport cap and arrived as ONE frame (permission frames have no chunking path: `#fit` at packages/geist-core/src/attach/attach-bridge.ts:732-736 splits only `output`).
- Repeat for a hostile `path` argument on a `read` call outside cwd, so the rule is proven on more than one field.

Give each test at least 90000ms.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/permission-safe-text.e2e.test.ts`

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/core/socket-server/safe-text.ts packages/gateway/src/__tests__/permission-safe-text.e2e.test.ts

### T13 — `draht --attach` renders and answers a permission ask

- **Wave** 4 · **Requirement** R34-PERM.2 · **Evidence class** 3 · **Depends on** T6, T8
- **Files** `packages/coding-agent/src/cli/attach-mode.ts`, `packages/coding-agent/test/attach-mode-permission.e2e.test.ts`
- **Test** `packages/coding-agent/test/attach-mode-permission.e2e.test.ts`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. `draht --attach <session>` is the second of the three renderers R34-PERM.2 and R34-PERM.4 name, and today it is the one that swallows answers. Its implementation is packages/coding-agent/src/cli/attach-mode.ts: `onOutput` writes session bytes straight to the TTY with `process.stdout.write(data)` (:99-105), and `rl.on("line")` forwards EVERY typed line as an `input` frame (:159-163) — which is exactly why typing 'Yes' becomes a queued new prompt instead of an answer. It hardcodes `mode: "read-write"` at :85-88, and keeps a `NON_FATAL_ERROR_CODES` set at :37.

WHAT ALREADY EXISTS: the socket wire carries `permission_request`, `permission_resolved` and `permission_response`; `SocketClient` (packages/coding-agent/src/core/socket-server/socket-client.ts) already exposes `onPermissionRequest` / `onPermissionResolved` callbacks and a `sendPermissionResponse()`, and declares the `permission-relay` capability in its attach frame. Every string field on the request frame arrives ALREADY neutralized and bounded — do not re-sanitize, and do not derive your own display string from the legacy `title`/`message` prose.

WHAT TO BUILD — packages/coding-agent/src/cli/attach-mode.ts only:
- Register `onPermissionRequest`: render the ask from the TYPED FIELDS (tool name, canonical cwd, command/path/operation, reason) as separate lines, plus a numbered list built from the frame's `options` array. Show a truncation notice when `truncated` is true. Do not splice any of this into the output stream.
- Enter an ANSWER MODE while an ask is outstanding: the next typed line is matched against the offered option ids/labels and sent with `sendPermissionResponse({ requestId, optionId })`, NOT `sendInput`. Anything that does not match one of the offered options is REJECTED LOCALLY with a one-line reminder and is forwarded as neither an answer nor a prompt. Answer mode ends only when a `permission_resolved` frame for that requestId arrives.
- Register `onPermissionResolved`: print who decided (`decision`, `surface`, `clientId`) and leave answer mode. This is R34-PERM.2's echo reaching this surface — the user must see 'answered on <surface>' when the phone won.
- Handle a `permission_request` for a requestId already outstanding (a replay after reconnect) idempotently: re-render once, do not queue two asks.
- Extend `NON_FATAL_ERROR_CODES` (:37) with the refusal codes the server returns for a rejected answer, so a refusal does not read as a fatal error.

THE TEST (NEW packages/coding-agent/test/attach-mode-permission.e2e.test.ts, vitest). EVIDENCE CLASS 3 — TWO emitted binaries talking over the real Unix socket wire, nothing imported:
- Build first: `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build`.
- Process 1: `node /Users/exe008/draht/draht-mono/packages/coding-agent/dist/cli.js --attachable --provider draht-stub --model stub-1 --mode json -p --no-session "run it"` with `DRAHT_STUB_PROVIDER=1`, `DRAHT_STUB_TOOL_CALLS` scripting one `bash` call that writes a marker file, `DRAHT_PERMISSION_MODE` DELETED from the child env, and `DRAHT_CODING_AGENT_DIR` set to a short directory directly under `/tmp` (a socket path over ~104 bytes fails to bind with EINVAL). Parse the startup banner for the session id.
- Process 2: `node .../dist/cli.js --attach <sessionId>` with the SAME `DRAHT_CODING_AGENT_DIR`, stdio piped.
- Assert process 2's stdout renders the ask with the tool name, the cwd and the command text on separate lines, and a numbered option list — and that it is not merely the raw legacy summary sentence.
- Write a NON-offered answer (`maybe`) to process 2's stdin: assert the marker file still does not exist and process 2 printed a reminder — proving the answer was neither forwarded as a prompt nor accepted.
- Write the offered answer to process 2's stdin: assert the marker file appears and process 2 prints a resolution line naming the deciding surface.
- Give the test at least 90000ms and kill both children in a `finally`.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono/packages/coding-agent && env -u DRAHT_PERMISSION_MODE npx vitest --run test/attach-mode-permission.e2e.test.ts`

Do not touch socket-client.ts, socket-server.ts or session-integration.ts — other owners.

Format when done, from /Users/exe008/draht/draht-mono:
./node_modules/.bin/biome check --write packages/coding-agent/src/cli/attach-mode.ts packages/coding-agent/test/attach-mode-permission.e2e.test.ts

### T14 — geist-console renders and answers a permission ask in a real browser

- **Wave** 4 · **Requirement** R34-PERM.2 · **Evidence class** 3 · **Depends on** T6, T8
- **Files** `packages/geist-console/bundle/console.js`, `packages/geist-console/bundle/console.css`, `scripts/geist-console-permission.e2e.test.mjs`
- **Test** `scripts/geist-console-permission.e2e.test.mjs`

CONTEXT. Repo root is /Users/exe008/draht/draht-mono. packages/geist-console/bundle/ is the single daemon-served browser bundle (console.js, console.css, index.html). Its frame switch is at console.js around line 552 (`case "output": addOutput(frame.data)`), with peer/joined/left/error cases following. It uses `textContent` everywhere and never `innerHTML` (zero `innerHTML`/`insertAdjacentHTML` in the package), so it is immune to HTML injection — but fully TRANSPARENT to bidi overrides, and streamed session text is concatenated into ONE shared agent bubble via `agentEntry.textContent += text` (console.js:267-268).

WHAT ALREADY EXISTS: the geist wire (`geist/0.x` member `0.3`) declares `permission_request` and `permission_resolved` server frames and a `permission_response` client frame. Every free-text field on the request arrives ALREADY neutralized and bounded, with `truncated` and `originalLength` shipped as data. The bundle must NOT re-derive a display string from raw input and must not re-sanitize.

WHAT TO BUILD.

(1) packages/geist-console/bundle/console.js:
- Add a `case "permission_request"` to the frame switch. It must create its OWN element — never `agentEntry.textContent +=`, which would let the ask inherit the transcript bubble's direction and blend into the agent's own words.
- Render the typed fields (tool, cwd, command/path/operation, reason) as separate elements set with `textContent`, plus one button per member of the frame's `options` array, label from `option.label` and value from `option.id`. Build the buttons from the array — never by parsing options out of text.
- Clicking a button sends a `permission_response` frame `{ type, clientId, requestId, optionId }` on the existing WebSocket, then disables the buttons pending the resolution.
- Add a `case "permission_resolved"`: replace the pending element's controls with a line naming `decision`, `surface` and `clientId`. This is R34-PERM.2's echo reaching the browser — a viewer must see when the ask was answered somewhere else.
- Show a truncation notice when `truncated` is true, using `originalLength`.
- Re-rendering the same `requestId` (a replay after reconnect) must be idempotent: update the existing element rather than appending a second ask.
- Keep using `textContent`. Do not introduce `innerHTML`, and do not add any external resource — packages/gateway/src/__tests__/console-csp.test.ts constrains what the served page may contain.

(2) packages/geist-console/bundle/console.css: style the permission element and give it `dir="ltr"` plus `unicode-bidi: isolate-override` so any residual direction can never reorder the surrounding UI. Match the existing class-naming style in the file.

THE TEST (NEW scripts/geist-console-permission.e2e.test.mjs, `node --test`). EVIDENCE CLASS 3 — real browser, DOM assertions against bytes the running daemon served. Model it closely on the EXISTING scripts/geist-console-bundle.e2e.test.mjs: read that file's header first — it explains the three real processes (the emitted packages/coding-agent/dist/cli.js `--attachable` against the stub provider, a daemon serving `/ui`, and headless Chromium via scripts/browser-harness.mjs), why the daemon is spawned from a temp `bun` host rather than the gateway CLI, and how it avoids reading the bundle off disk to check what the page 'should' contain. Reuse those helpers rather than reinventing them.

Drive a real `bash` tool call via `DRAHT_STUB_TOOL_CALLS` (with `DRAHT_STUB_PROVIDER=1`, `DRAHT_PERMISSION_MODE` DELETED from the child env, and a short `/tmp` agent dir for the 104-byte sun_path limit). Assert in the browser DOM:
- A permission element appears carrying the tool name, the cwd and the command text, in its OWN element — assert the agent bubble's textContent does NOT contain the command.
- One button exists per offered option, with labels from the frame.
- Clicking the approve button makes the tool run (assert the marker file from the test process) and a resolution line appears naming the deciding surface.
- A hostile command (leading `[2J`, an embedded `‮`, ~5000 chars) renders with no C0 and no U+202A-U+202E anywhere in the element's textContent, and the decisive tail is still visible.
- Give the test a generous timeout; the existing console e2e runs in the serial script bucket for this reason.

WIRING NOTE — DO NOT EDIT ROOT package.json. scripts/root-test-script-parity.test.mjs fails the build for any `scripts/*.test.mjs` that `npm test` does not reach, so the new file must be added to the root `test:scripts:serial` line — the ORCHESTRATOR makes that edit, not you. Say in your handoff that it is required.

RUN ONLY YOUR OWN TEST FILE:
`cd /Users/exe008/draht/draht-mono && env -u DRAHT_PERMISSION_MODE node --test --test-timeout=300000 scripts/geist-console-permission.e2e.test.mjs`

Format when done, from /Users/exe008/draht/draht-mono (note: biome.json's `files.includes` covers only `packages/*/src/**` and `packages/*/test/**`, so these paths are outside biome's scope and the command is expected to be a no-op — run it anyway so the record is uniform):
./node_modules/.bin/biome check --write packages/geist-console/bundle/console.js packages/geist-console/bundle/console.css scripts/geist-console-permission.e2e.test.mjs

## Shared files — orchestrator only

- package.json — the ROOT package.json only. Its `test:scripts:serial` line must gain `scripts/geist-console-permission.e2e.test.mjs` (created by T14), because `scripts/root-test-script-parity.test.mjs` fails the build for any `scripts/*.test.mjs` that `npm test` does not reach. No task may edit this file; the orchestrator makes the edit after T14 lands. New `packages/gateway/src/__tests__/*.e2e.test.ts` files (T6, T8, T9, T10, T11, T12) need NO root edit — the parity guard already reaches them through the workspace fan-out — and new `packages/coding-agent/test/*.ts` files (T1..T5, T7, T13) are picked up by that package's vitest glob.

## Ordering constraints

- ADVISOR OVERRIDE #1 (both advisors vs MAP lens 2 and lens 4): the RelayUIContext decorator is installed at packages/coding-agent/src/core/agent-session.ts:2360 inside `_applyExtensionBindings`, NOT at main.ts:913-939 and NOT inside `makeSessionAttachable`. The map's lens-2 seam point ('main.ts:913-939 :: where a RelayUIContext decorator over the base context is installed') and lens-4's equivalent are WRONG as install sites: `bindExtensions` (agent-session.ts:2281-2284) later assigns `_extensionUIContext` and `_applyExtensionBindings` re-pushes it, so a wrap installed at the attach seam is silently overwritten by interactive (interactive-mode.ts:1673) and rpc (rpc-mode.ts:341). main.ts only HANDS the relay handle over (T8); agent-session.ts:2360 does the wrapping (T4).
- ADVISOR 2 CORRECTS THE MAP (durability lens): the claim that 'bindExtensions assigns the ui context unconditionally' is wrong — agent-session.ts:2282-2284 guards with `if (bindings.uiContext !== undefined)`, verified by reading. Print mode therefore never clobbers a pre-set context; the overwrite hazard exists only for interactive and rpc. The conclusion (compose at :2360) is unchanged, and T4's brief states the guard so no implementer 'fixes' it.
- ADVISOR 1 CORRECTS THE MAP (lens 3): the seam point claiming interactive mode 'needs an external-resolution path ... which today has no mechanism at all' is wrong. `opts.signal` IS the external-resolution path and is fully implemented — showExtensionSelector checks `signal.aborted` upfront (interactive-mode.ts:2251) and registers an abort listener that tears down the selector and resolves (:2259-2262), and showExtensionConfirm maps abort to `false` (:2307). What is missing is only the deciding-surface RENDERING. T7 is scoped to that, not to building a dismissal mechanism.
- ADVISOR 1 AMENDS R34-PERM.2 AS WRITTEN: a decorator over the base context CANNOT satisfy R34-PERM.3 on its own, because the gate passes prose (`ctx.ui.confirm("Approve tool call?", `${toolName}: ${reason}`)` at subagent.ts:605) and no decorator can reconstruct toolCallId/cwd/command from a string. The decorator (T4) and the widened ask via `ExtensionUIDialogOptions.detail` (T5) are ONE design split across waves 1 and 2. Nothing may ship a relay that forwards the summary sentence.
- ADVISOR 1 ADDS AN ORDERING RULE R34-PERM.2 DOES NOT STATE, and it is load-bearing: settle -> resolve -> THEN abort the losing surfaces -> broadcast the resolution -> append the JSONL record. Aborting first re-enters the decorator as a FABRICATED TUI DENY (the abort resolves the TUI selector to `undefined`, which interactive-mode.ts:2307 maps to `false`) and overwrites a remote approve. Encoded in T4's brief, step (d).
- ADVISOR 1 AND 2 AMEND runner.hasUI(): it must stop being the identity check `this.uiContext !== noOpUIContext` (runner.ts:464-466). Otherwise installing the decorator flips it TRUE for every headless `--attachable -p` run with no client attached, and today's loud 'no UI available to request approval' block becomes the wrapped no-op's instant `false`, which subagent.ts:606-608 reports as 'User denied approval' — a fabricated user action in the transcript. T4 lands the `hasAnswerSurface()` probe in the SAME task as the decorator, never as a follow-up.
- ADVISOR 2 CORRECTS R34-PERM.1's 'deadline': the frame's deadline is ADVISORY RENDERING DATA. Real expiry binds solely to the registry's fail-closed timer — ONE clock. An enforced frame deadline would be a NEW denial path that contradicts the archived R34-PERM.8 measurement (the agent core imposes none; 25 minutes with zero degradation; 'hold the turn' is the primary mechanism). Encoded in T10.
- ADVISOR 2 CORRECTS R34-PERM.4's 'protocol layer': read as geist-protocol alone it silently leaves `draht --attach` unprotected, whose client is a bare `JSON.parse(line) as ServerMessage` cast (socket-client.ts:177) that never touches geist-protocol. Neutralization happens where the frame is CONSTRUCTED, on the coding-agent socket-server side (T2 + T5), and is RE-ASSERTED in wire.ts with `.refine()` — never `.transform()`, which changes inferred types and makes decode/encode non-idempotent while the conformance goldens compare byte-wise (T6). geist-protocol keeps zero @draht dependencies, so the predicate is hand-mirrored there, not imported.
- ADVISOR 2 CORRECTS R34-PERM.7 ON TWO COUNTS. (a) It is VACUOUS until the surface exists: under shipped defaults no local prompt is raised headless at all (subagent.ts:602 hard-blocks), so 'every execution that raises a local prompt' enumerates the empty set — hence T11 depends on T5 and T8 and asserts OBSERVED frames against a literal argument-vector table, never `PermissionGate.evaluate` (a tautology that would keep passing if the gate were unwired). (b) The SUBAGENT leg is unsatisfiable as written — the child is spawned `--mode json -p --no-session` with no socket, no UI and no env channel (subagent.ts:241-266) — and is therefore NOT PLANNED. It is escalated in openForOskar and T11's brief must say so in a comment rather than attempt it.
- LANDING ORDER IS ASYMMETRIC AND LOAD-BEARING: geist-protocol must DECLARE the permission frames before any draht binary EMITS them, i.e. T6 (wave 2) strictly before T8 (wave 3). Verified by running a real bridge: an undeclared socket-wire frame drops the renderer with `protocol_error unknown_type` and close 1008 (attach-bridge.ts:699-720). The reverse skew is SILENT — an unknown client message vanishes with no reply because socket-server.ts:454-529 has no default case — so T6 adds both the missing default-case error AND the attach-time `capabilities` field that gates emission, which is what stops a new draht from killing an old geist-core bridge.
- T6 IS ATOMIC BY BUILD GATE, NOT BY PREFERENCE. `MIRRORED_UNIONS` (scripts/check-geist-protocol.mjs:94, failure text at :253-254) fails on any ClientMessage/ServerMessage member with no geist mirror; `missingGoldens` (scripts/generate-geist-conformance.mjs:159-169) fails on any declared type with no recorded golden per direction; `hasMigrationNote` (:218-221) fails without a `## geist/0.3` heading. Splitting the socket types, the wire schemas, the mirror rows, the version bump, the migration note, the recorder extension and the regenerated corpus across tasks fails the build. One owner, one change.
- CURRENT_SESSION_VERSION (session-manager.ts:30) MUST STAY 3. packages/agent/src/harness/session/jsonl-storage.ts:77 hard-throws 'unsupported session version' on anything else, and :103-131 throws per line without id/parentId/timestamp. The trap is an implementer 'correctly' versioning an additive schema change. Encoded in T3.
- CLASS-3 HARNESS HYGIENE, mandatory in every task that spawns a binary: DELETE `DRAHT_PERMISSION_MODE` from the child env (this repo's interactive shell exports `auto`, which has already contaminated two prior probes and makes a permission test pass while proving nothing); put the agent dir directly under `/tmp` with a SHORT name (a Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS `os.tmpdir()` is ~50 chars before a uuid); and run `cd /Users/exe008/draht/draht-mono/packages/coding-agent && bun run build` before anything that spawns `dist/cli.js`.
- IMPLEMENTERS RUN ONLY THEIR OWN NAMED TEST FILE. Whole-package suites flake under parallel load. Per-package runners: coding-agent uses vitest (`npx vitest --run <relative path>` from that package); gateway, geist-protocol and geist-core use `bun test <relative path>`; scripts use `node --test`.
- DELIBERATELY NOT PLANNED, each for a stated reason. (1) The project-trust prompt: raised at main.ts:738, strictly BEFORE the attach handle exists at main.ts:916, and its `ProjectTrustContext.ui` is only a 4-method Pick (extensions/types.ts:538-543) — unreachable at this seam by construction, so R34-PERM.7 cannot cover it. (2) The subagent leg of R34-PERM.7 (see above). (3) draht-acp binding a real uiContext — both advisors want it, but the ACP seam was explicitly rejected and it serves none of R34-PERM.1..8; escalated. (4) packages/geist-protocol/src/messages.ts's rejected-seam permission_request/permission_answer envelope — renaming or deleting it would drag packages/geist/src/pairing/server.ts and session-bridge.ts into T6's file set; escalated instead. (5) Hardware/tailnet residuals and the deliberately-red tailnet-identity test, per instruction.

## Open for Oskar

- R34-PERM.7's subagent leg: keep it in Phase 34 or re-scope it? It is unsatisfiable today — a subagent is a separate `draht --mode json -p --no-session` process (subagent.ts:241-266) with no socket, no UI and no env passed, so an approve-tier call there raises NO prompt anywhere and hard-blocks. Options: pass a relay endpoint to the child in `env`, proxy its asks back over the JSON stdout stream it already uses, spawn the child `--attachable` on its own socket, or amend the requirement. Product call, not an implementation detail.
- The zero-attached-client regime for an `--attachable` session. The plan KEEPS today's loud fail-closed block ('no UI available to request approval'). The alternative is to hold the turn until someone attaches — which R34-PERM.6's durable pending registry implies and R34-PERM.8's 25-minute measurement makes viable, but which nothing in the requirements actually says. Confirm the choice; it is user-visible.
- The registry expiry deadline needs a NUMBER. R34-PERM.6 says expiry fails closed, R34-PERM.8 measured that the agent core imposes no deadline at all, and the only existing time bound in this area is UNWRITTEN_LOCK_STALE_MS (10s, for an unrelated purpose). What should an unanswered ask cost before it is denied?
- Should draht-acp bind a real ExtensionUIContext (confirm -> `session/request_permission`, draht-acp-agent.ts:164-186)? Both advisors call it a must-have: it fixes the shipped hard-fail for external ACP clients and demotes Gate B from a second gate to Gate A's renderer, pre-empting a duplicate-ask bug where one bash call raises two asks on the same phone. It is NOT one of R34-PERM.1..8 and the ACP seam was explicitly rejected, so it is unplanned pending your call.
- Two permission vocabularies will coexist in one leaf package unless you decide otherwise. packages/geist-protocol/src/messages.ts:21-57 already declares `permission_request`/`permission_answer` in a `{type, payload}` envelope for the rejected pairing server (whose `createPairingServer` is called from tests only, and whose `geist` binary dispatches only `pair` and `devices`). The new attach-wire frames are flat `{type, ...}`. Both export from the same barrel. Rename, delete, or keep both with a comment?
- The offered-option set: keep the current implicit two-way Yes/No (subagent.ts:605 -> ["Yes","No"]), or adopt the ACP-style {allow_once, reject_once, allow_always} that draht-acp already offers (draht-acp-agent.ts:180-183)? All three renderers must agree on ONE set, and R34-PERM.5 stores it immutably per request, so changing it later is a wire change. The plan currently freezes [{approve},{deny}].
- Is the geist-console browser renderer (T14) genuinely in Phase 34's scope, or does it wait for the phone app? It is the only task requiring a root package.json edit, it is the largest UI surface, and R34-PERM.4's 'all three renderers' is the only requirement text that reaches it. Cutting it drops the plan to 13 tasks and removes the shared-file coupling.
- Disclosure widening, deliberate and worth an explicit yes. The new PermissionResolutionEntry puts the raw command and canonical cwd into the session JSONL, which the RPC `get_entries` command ships verbatim to any RPC client (rpc-types.ts:200) and which /export-html embeds in full into a shareable HTML document (export-html/index.ts passes the whole entries array into the template's embedded JSON, even though the template renders unknown types as just `[type]`). R34-PERM.4's protocol-layer bounding does not protect that copy.
- Decorating `confirm`/`select` wholesale also relays two non-tool prompts: checkpoint file-restore (`ctx.ui.confirm("Restore files?", ...)` at checkpoints.ts:112) and the /agent selector (`ctx.ui.select("Select agent for your prompts", ...)` at subagent.ts:964), plus any third-party extension's own dialogs. That is arguably right under R34-PERM.7's spirit — but it means a phone will be asked things nobody planned for it. Confirm this is intended rather than discovered in the field.
