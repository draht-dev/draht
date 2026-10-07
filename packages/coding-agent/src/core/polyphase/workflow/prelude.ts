/**
 * Builds the single-line VM prelude injected before a workflow script's body (DESIGN.md §13.2).
 *
 * The prelude must stay one line because the sandbox evaluates `prelude + body` as a single
 * `codemode.js` source, and the first line of `body` shares line 1 of that source with the
 * prelude: any newline here would shift every reported script line and column.
 */

import type { WorkflowMeta } from "./meta.ts";

export const RESERVED_SCRIPT_NAMES: readonly string[] = [
	"agent",
	"parallel",
	"pipeline",
	"phase",
	"log",
	"args",
	"budget",
	"meta",
];

/**
 * Shared with runtime.ts's host-side guard on `agent()`'s `phase` field: both import this one
 * constant, so there is nothing to keep in sync. Checking it here too (a deviation from
 * DESIGN.md §13.2's verbatim `phase` statement) makes an overlong `phase(title)` throw at its own
 * call site instead of silently poisoning every later `agent()` call with no reported source line.
 */
export const PHASE_MAX_CHARS = 80;

export interface PreludeInput {
	meta: WorkflowMeta;
	args: string;
	budgetTokens: number | null;
	maxItemsPerCall: number;
}

/**
 * `JSON.stringify(Infinity)` and `JSON.stringify(NaN)` are both `"null"`, which would embed as
 * `const __polyphaseMax = null;`; `thunks.length > null` is then true for any non-empty array, so
 * every `parallel()`/`pipeline()` call would throw regardless of its actual size. A value below 1
 * would make the cap tighter than any real call. Clamping here, at the embedding boundary, keeps
 * `statements()` free of this defensive check.
 */
function normalizeMaxItemsPerCall(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : Number.MAX_SAFE_INTEGER;
}

/**
 * `JSON.stringify` never emits a raw newline, but it does emit `//` verbatim for any embedded
 * string containing it (a URL, for instance), which would trip `buildWorkflowPrelude`'s
 * single-line/no-comment assertion below. `\/` is a valid JS string escape, so swapping it in
 * keeps the JSON valid while making `//` impossible to reconstruct from embedded data. U+2028 and
 * U+2029 are valid unescaped in JS string literals but are line terminators for ASI purposes;
 * escaping them keeps the prelude's line-counting invariant exact for any input.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function embed(value: unknown): string {
	return JSON.stringify(value)
		.replace(/\//g, "\\/")
		.split(LINE_SEPARATOR)
		.join("\\u2028")
		.split(PARAGRAPH_SEPARATOR)
		.join("\\u2029");
}

/**
 * Beyond DESIGN.md §13.2's verbatim statement list, this also bans `performance.now` (the same
 * determinism rationale as `Date.now`/`Math.random`, otherwise an uncovered escape hatch), pins
 * `Date.prototype.constructor` to the banning proxy (so `x.constructor()` can't bypass the ban the
 * way the determinism test exercises), and has `agent()` capture the call site with `new Error()`
 * before awaiting, rewriting a `{ok:false}` reply's stack onto it so a thrown agent failure reports
 * its script line instead of only the prelude's. Each is intentional; none is in §13.2.
 */
function statements(input: PreludeInput): string[] {
	return [
		`const meta = Object.freeze(${embed(input.meta)});`,
		`const args = ${embed(input.args)};`,
		"let __polyphasePhase = undefined; let __polyphaseSpent = 0;",
		`const __polyphaseMax = ${embed(normalizeMaxItemsPerCall(input.maxItemsPerCall))}; const __polyphaseTotal = ${embed(input.budgetTokens)};`,
		"const budget = Object.freeze({ total: __polyphaseTotal, spent: () => __polyphaseSpent, remaining: () => __polyphaseTotal === null ? Infinity : Math.max(0, __polyphaseTotal - __polyphaseSpent) });",
		'const __polyphaseBan = (n) => () => { throw new Error(n + " is not available in workflow scripts: runs must be deterministic"); };',
		'Object.defineProperty(Math, "random", { value: __polyphaseBan("Math.random"), writable: false, configurable: false });',
		'if (typeof performance === "object" && performance !== null) { const __polyphaseDescs = Object.getOwnPropertyDescriptors(performance); __polyphaseDescs.now = { value: __polyphaseBan("performance.now"), writable: false, enumerable: true, configurable: false }; globalThis.performance = Object.create(Object.getPrototypeOf(performance), __polyphaseDescs); }',
		"const __polyphaseDate = Date;",
		'Object.defineProperty(__polyphaseDate, "now", { value: __polyphaseBan("Date.now"), writable: false, configurable: false });',
		'const __polyphaseDateProxy = new Proxy(__polyphaseDate, { apply() { return __polyphaseBan("Date()")(); }, construct(t, a, nt) { if (a.length === 0) return __polyphaseBan("new Date()")(); return Reflect.construct(t, a, nt); } });',
		'Object.defineProperty(__polyphaseDate.prototype, "constructor", { value: __polyphaseDateProxy, writable: false, configurable: false });',
		"globalThis.Date = __polyphaseDateProxy;",
		'const __polyphaseText = (p) => typeof p === "string" ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })();',
		'const log = (...parts) => { __polyphase.log(parts.map(__polyphaseText).join(" "), "info").catch(() => undefined); };',
		'const __polyphaseWarn = (text) => { __polyphase.log(text, "warning").catch(() => undefined); };',
		`const phase = (title) => { if (typeof title !== "string" || title.trim() === "" || title.length > ${PHASE_MAX_CHARS}) throw new TypeError("phase(title) needs a non-empty string of at most ${PHASE_MAX_CHARS} characters"); __polyphasePhase = title; __polyphase.phase(title).catch(() => undefined); };`,
		'const agent = async (prompt, opts) => { if (typeof prompt !== "string" || prompt.length === 0) throw new TypeError("agent(prompt, opts) needs a non-empty prompt string"); if (opts !== undefined && (opts === null || typeof opts !== "object" || Array.isArray(opts))) throw new TypeError("agent(prompt, opts): opts must be an object"); const o = opts === undefined ? {} : opts; const __polyphaseSite = new Error(); const reply = await __polyphase.agent({ prompt, label: o.label, phase: o.phase !== undefined ? o.phase : __polyphasePhase, schema: o.schema, model: o.model, effort: o.effort, isolation: o.isolation, agentType: o.agentType }); __polyphaseSpent = reply.spent; if (!reply.ok) { const __polyphaseErr = new Error(reply.error); const __polyphaseStack = __polyphaseSite.stack; if (typeof __polyphaseStack === "string") { const __polyphaseNL = __polyphaseStack.indexOf("\\n"); __polyphaseErr.stack = "Error: " + reply.error + (__polyphaseNL === -1 ? "" : __polyphaseStack.slice(__polyphaseNL)); } throw __polyphaseErr; } return reply.value; };',
		'const __polyphaseMessage = (e) => e && typeof e.message === "string" ? e.message : String(e);',
		'const parallel = async (thunks) => { if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks) needs an array of functions, e.g. items.map((x) => () => agent(...))"); if (thunks.length > __polyphaseMax) throw new RangeError("parallel() accepts at most " + __polyphaseMax + " items"); for (const t of thunks) if (typeof t !== "function") throw new TypeError("parallel(thunks): every item must be a function"); return Promise.all(thunks.map(async (t, i) => { try { return await t(); } catch (e) { __polyphaseWarn("parallel item " + i + " failed: " + __polyphaseMessage(e)); return null; } })); };',
		'const pipeline = async (items, ...stages) => { if (!Array.isArray(items)) throw new TypeError("pipeline(items, ...stages) needs an array of items"); if (items.length > __polyphaseMax) throw new RangeError("pipeline() accepts at most " + __polyphaseMax + " items"); if (stages.length === 0 || stages.some((s) => typeof s !== "function")) throw new TypeError("pipeline(items, ...stages): stages must be functions (prev, item, index) => ..."); return Promise.all(items.map(async (item, index) => { let prev = item; for (let s = 0; s < stages.length; s++) { try { prev = await stages[s](prev, item, index); } catch (e) { __polyphaseWarn("pipeline item " + index + " failed in stage " + (s + 1) + ": " + __polyphaseMessage(e)); return null; } } return prev; })); };',
	];
}

export function buildWorkflowPrelude(input: PreludeInput): string {
	const prelude = statements(input).join(" ");
	if (prelude.includes("\n") || prelude.includes("//")) {
		throw new Error("buildWorkflowPrelude produced a multi-line prelude or a line comment; this is a bug");
	}
	return prelude;
}
