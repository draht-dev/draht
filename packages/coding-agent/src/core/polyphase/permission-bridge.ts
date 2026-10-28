/**
 * The permission bridge: a polyphase child asks its parent session to decide a permission ask it
 * cannot answer itself.
 *
 * A child runs `--mode json -p` and has no UI of its own, so before this every `approve` decision
 * inside it ended as a block nobody had been asked about. The bridge carries the ask to the parent
 * over the Node IPC channel `child-process.ts` opens next to the child's stdio (Bun implements the
 * same channel, including for a compiled binary spawning itself). Only a child spawned with
 * {@link POLYPHASE_PERMISSION_BRIDGE_ENV} set uses it, so a draht process some unrelated IPC parent
 * forked never writes to that parent's channel.
 *
 * Child to parent: `ask` (one per gated tool call) and `withdraw` (the child's turn was aborted
 * while it waited). Parent to child: `answer`. Neither side trusts the other's strings: every
 * message is validated and bounded on arrival, the parent rebuilds the dialog from the raw
 * arguments with its own neutralization, and the cwd a request is evaluated against comes from the
 * parent's own spawn spec, never from the child.
 */

import { randomUUID } from "node:crypto";
import type {
	ChildPermissionAsker,
	ChildPermissionInput,
	ChildPermissionRequest,
	ChildPermissionValue,
	ChildPermissionVerdict,
} from "./types.ts";

/** Set to `"1"` in a child's environment when its parent serves permission asks over IPC. */
export const POLYPHASE_PERMISSION_BRIDGE_ENV = "DRAHT_POLYPHASE_PERMISSION_BRIDGE";

const ASK_TYPE = "draht.permission.ask";
const WITHDRAW_TYPE = "draht.permission.withdraw";
const ANSWER_TYPE = "draht.permission.answer";

/**
 * Argument keys the permission gate decides on. They cross verbatim and are never shortened: a
 * cut `command` would let the parent approve a different call than the one the child runs.
 */
const GATE_ARG_KEYS: ReadonlySet<string> = new Set(["command", "path", "file_path"]);

const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 256;
const MAX_INPUT_KEYS = 64;
const MAX_DISPLAY_VALUE_CHARS = 2048;
const MAX_INPUT_CHARS = 256 * 1024;
const MAX_VIA_LABELS = 8;
const MAX_REASON_CHARS = 4096;
/** Display-only key standing in for the arguments the key cap left out of a dialog. */
const OMITTED_ARGS_KEY = "(more arguments)";

export interface PermissionAskMessage {
	type: typeof ASK_TYPE;
	id: string;
	toolName: string;
	toolCallId: string;
	input: ChildPermissionInput;
	via: string[];
}

export interface PermissionWithdrawMessage {
	type: typeof WITHDRAW_TYPE;
	id: string;
}

export interface PermissionAnswerMessage {
	type: typeof ANSWER_TYPE;
	id: string;
	verdict: ChildPermissionVerdict["kind"];
	reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isScalar(value: unknown): value is ChildPermissionValue {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		value === null ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function boundDisplayValue(text: string): string {
	return text.length > MAX_DISPLAY_VALUE_CHARS ? `${text.slice(0, MAX_DISPLAY_VALUE_CHARS)}…` : text;
}

function serializeForDisplay(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * A tool call's arguments as they cross the bridge: the gate's own keys verbatim, every other value
 * reduced to a bounded scalar that only feeds the dialog.
 *
 * The gate keys are taken FIRST and never give way to the key cap. Capping them in argument order
 * let a call bury its `path` behind 64 junk keys (integer-like keys always enumerate first): the
 * parent then judged a pathless `grep` (the project cwd) and approved, unasked, a read anywhere.
 *
 * A non-string gate value is ignored by the gate, so the parent's gate must not see it either; it
 * crosses under a key the gate never reads, where the dialog still shows it. Serializing it into the
 * gate key instead would hand the parent's gate a command or path the child's gate never judged.
 */
export function toChildPermissionInput(input: Record<string, unknown>): ChildPermissionInput {
	const gate: [string, ChildPermissionValue][] = [];
	const display: [string, ChildPermissionValue][] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (GATE_ARG_KEYS.has(key)) {
			if (typeof value === "string") gate.push([key, value]);
			else display.push([`${key} (not a string)`, boundDisplayValue(serializeForDisplay(value))]);
			continue;
		}
		if (key.length === 0 || key.length > MAX_NAME_CHARS) continue;
		if (typeof value === "string") display.push([key, boundDisplayValue(value)]);
		else if (isScalar(value)) display.push([key, value]);
		else display.push([key, boundDisplayValue(serializeForDisplay(value))]);
	}
	const room = MAX_INPUT_KEYS - gate.length;
	const shown =
		display.length <= room
			? display
			: [...display.slice(0, room - 1), [OMITTED_ARGS_KEY, `${display.length - room + 1} more not shown`] as const];
	// `Object.fromEntries` defines own properties, so a `__proto__` key stays a plain key.
	return Object.fromEntries([...gate, ...shown]);
}

function parseInput(value: unknown): ChildPermissionInput | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length > MAX_INPUT_KEYS) return undefined;
	const parsed: [string, ChildPermissionValue][] = [];
	let chars = 0;
	for (const [key, entry] of entries) {
		if (key.length === 0 || key.length > MAX_NAME_CHARS || !isScalar(entry)) return undefined;
		chars += key.length + (typeof entry === "string" ? entry.length : 0);
		if (chars > MAX_INPUT_CHARS) return undefined;
		parsed.push([key, entry]);
	}
	return Object.fromEntries(parsed);
}

function parseVia(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_VIA_LABELS) return undefined;
	const labels: string[] = [];
	for (const label of value) {
		if (!isBoundedString(label, MAX_NAME_CHARS)) return undefined;
		labels.push(label);
	}
	return labels;
}

/**
 * What arrived on a child's channel, when it claims to be an ask. An ask with a usable `id` but an
 * unusable body is still answered (`unavailable`), or the child's gate would wait for an answer
 * that never comes; one without a usable `id` cannot be answered at all and is dropped.
 */
export type ParsedAsk = { ok: true; message: PermissionAskMessage } | { ok: false; id: string };

export function parseAskMessage(value: unknown): ParsedAsk | undefined {
	if (!isRecord(value) || value.type !== ASK_TYPE || !isBoundedString(value.id, MAX_ID_CHARS)) return undefined;
	const id = value.id;
	const input = parseInput(value.input);
	const via = parseVia(value.via);
	if (
		!isBoundedString(value.toolName, MAX_NAME_CHARS) ||
		!isBoundedString(value.toolCallId, MAX_NAME_CHARS) ||
		input === undefined ||
		via === undefined
	) {
		return { ok: false, id };
	}
	return {
		ok: true,
		message: { type: ASK_TYPE, id, toolName: value.toolName, toolCallId: value.toolCallId, input, via },
	};
}

export function parseWithdrawMessage(value: unknown): PermissionWithdrawMessage | undefined {
	if (!isRecord(value) || value.type !== WITHDRAW_TYPE || !isBoundedString(value.id, MAX_ID_CHARS)) return undefined;
	return { type: WITHDRAW_TYPE, id: value.id };
}

const VERDICT_KINDS: readonly ChildPermissionVerdict["kind"][] = ["approved", "denied", "unavailable", "cancelled"];

function isVerdictKind(value: unknown): value is ChildPermissionVerdict["kind"] {
	return typeof value === "string" && (VERDICT_KINDS as readonly string[]).includes(value);
}

/** The answer's verdict, or `undefined` when `value` is not a well-formed answer. */
export function parseAnswerMessage(value: unknown): { id: string; verdict: ChildPermissionVerdict } | undefined {
	if (!isRecord(value) || value.type !== ANSWER_TYPE || !isBoundedString(value.id, MAX_ID_CHARS)) return undefined;
	if (!isVerdictKind(value.verdict)) return undefined;
	if (value.verdict === "denied") {
		const reason = isBoundedString(value.reason, MAX_REASON_CHARS) ? value.reason : "Denied in the parent session";
		return { id: value.id, verdict: { kind: "denied", reason } };
	}
	return { id: value.id, verdict: { kind: value.verdict } };
}

function toAnswerMessage(id: string, verdict: ChildPermissionVerdict): PermissionAnswerMessage {
	const message: PermissionAnswerMessage = { type: ANSWER_TYPE, id, verdict: verdict.kind };
	if (verdict.kind === "denied") message.reason = verdict.reason.slice(0, MAX_REASON_CHARS);
	return message;
}

// ── Child side ───────────────────────────────────────────────────────────────

/** The child's end of the IPC channel: `process` in production, a fake in tests. */
export interface ParentChannel {
	isConnected(): boolean;
	send(message: PermissionAskMessage | PermissionWithdrawMessage, callback: (error: Error | null) => void): void;
	/** Returns the unsubscribe. While subscribed, Node and Bun keep the process alive. */
	subscribe(onMessage: (message: unknown) => void, onDisconnect: () => void): () => void;
}

export interface ParentPermissionAsk {
	toolName: string;
	toolCallId: string;
	input: ChildPermissionInput;
	/** Labels of the agents below this process the ask already passed through, outermost first. */
	via: readonly string[];
}

export interface ParentPermissionBridge {
	/** Have the parent decide one gated call. Never rejects. */
	ask(request: ParentPermissionAsk, signal?: AbortSignal): Promise<ChildPermissionVerdict>;
}

export function createParentPermissionBridge(channel: ParentChannel): ParentPermissionBridge {
	const pending = new Map<string, (verdict: ChildPermissionVerdict) => void>();
	let unsubscribe: (() => void) | undefined;

	const onMessage = (message: unknown) => {
		const answer = parseAnswerMessage(message);
		if (answer) pending.get(answer.id)?.(answer.verdict);
	};
	const onDisconnect = () => {
		for (const settle of [...pending.values()]) settle({ kind: "unavailable" });
	};

	return {
		ask(request, signal) {
			if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
			if (!channel.isConnected()) return Promise.resolve({ kind: "unavailable" });
			const id = randomUUID();
			return new Promise<ChildPermissionVerdict>((resolve) => {
				const settle = (verdict: ChildPermissionVerdict) => {
					if (!pending.delete(id)) return;
					signal?.removeEventListener("abort", onAbort);
					// Subscribed, the channel keeps this process alive after its work is done, so it is
					// held only while an ask is actually waiting.
					if (pending.size === 0) {
						unsubscribe?.();
						unsubscribe = undefined;
					}
					resolve(verdict);
				};
				const onAbort = () => {
					// Takes the parent's dialog down; the parent's late answer, if any, finds nothing to settle.
					if (channel.isConnected()) {
						try {
							channel.send({ type: WITHDRAW_TYPE, id }, () => {});
						} catch {}
					}
					settle({ kind: "cancelled" });
				};
				pending.set(id, settle);
				unsubscribe ??= channel.subscribe(onMessage, onDisconnect);
				signal?.addEventListener("abort", onAbort, { once: true });
				const message: PermissionAskMessage = {
					type: ASK_TYPE,
					id,
					toolName: request.toolName,
					toolCallId: request.toolCallId,
					input: request.input,
					via: [...request.via],
				};
				try {
					channel.send(message, (error) => {
						if (error) settle({ kind: "unavailable" });
					});
				} catch {
					settle({ kind: "unavailable" });
				}
			});
		},
	};
}

function processParentChannel(): ParentChannel | undefined {
	if (typeof process.send !== "function") return undefined;
	return {
		isConnected: () => process.connected === true,
		send: (message, callback) => {
			process.send?.(message, callback);
		},
		subscribe: (onMessage, onDisconnect) => {
			process.on("message", onMessage);
			process.on("disconnect", onDisconnect);
			return () => {
				process.off("message", onMessage);
				process.off("disconnect", onDisconnect);
			};
		},
	};
}

let processBridgeClaimed = false;
let processBridge: ParentPermissionBridge | undefined;

/**
 * Takes this process's bridge marker out of its environment and, when the marker was set and an
 * IPC channel to the parent exists, connects the bridge. Idempotent. `main()` calls it before
 * anything is spawned: like Node's own `NODE_CHANNEL_FD`, the marker is consumed, so no tool
 * subprocess or extension child inherits a claim on an IPC channel it does not own (a vitest worker
 * started from a bridged child would otherwise send its asks to vitest and wait forever).
 */
export function claimParentPermissionBridge(): void {
	if (processBridgeClaimed) return;
	processBridgeClaimed = true;
	const requested = process.env[POLYPHASE_PERMISSION_BRIDGE_ENV] === "1";
	delete process.env[POLYPHASE_PERMISSION_BRIDGE_ENV];
	const channel = requested ? processParentChannel() : undefined;
	processBridge = channel ? createParentPermissionBridge(channel) : undefined;
}

/**
 * This process's bridge to the polyphase parent that spawned it, or `undefined` when there is
 * none: not a bridged child, or no IPC channel to its parent.
 */
export function getParentPermissionBridge(): ParentPermissionBridge | undefined {
	claimParentPermissionBridge();
	return processBridge;
}

// ── Parent side ──────────────────────────────────────────────────────────────

/** The parent's end of one child's IPC channel. `ChildProcess` satisfies it. */
export interface ChildChannel {
	readonly connected: boolean;
	send(message: PermissionAnswerMessage, callback: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
}

export interface ServeChildPermissionAsksOptions {
	/** Where the child was spawned: what every request from it is evaluated against. */
	cwd: string;
	/** Aborts every pending ask, e.g. the agent's own cancellation. */
	signal?: AbortSignal;
	onAsk?: (request: ChildPermissionRequest) => void;
	onVerdict?: (request: ChildPermissionRequest, verdict: ChildPermissionVerdict) => void;
}

export interface ChildPermissionServer {
	/** Stop listening and abort every pending ask. Idempotent. */
	dispose(): void;
}

/** Answers one child's permission asks with `asker`, until the child exits and `dispose` is called. */
export function serveChildPermissionAsks(
	child: ChildChannel,
	asker: ChildPermissionAsker,
	options: ServeChildPermissionAsksOptions,
): ChildPermissionServer {
	const pending = new Map<string, AbortController>();
	let disposed = false;

	const reply = (id: string, verdict: ChildPermissionVerdict) => {
		if (disposed || !child.connected) return;
		try {
			child.send(toAnswerMessage(id, verdict), () => {});
		} catch {
			// The child went away between the check and the send; it has nothing left to settle.
		}
	};

	const onMessage = (message: unknown) => {
		if (disposed) return;
		const withdraw = parseWithdrawMessage(message);
		if (withdraw) {
			pending.get(withdraw.id)?.abort();
			return;
		}
		const parsed = parseAskMessage(message);
		if (parsed === undefined) return;
		if (!parsed.ok) {
			reply(parsed.id, { kind: "unavailable" });
			return;
		}
		const ask = parsed.message;
		if (pending.has(ask.id)) return;
		const controller = new AbortController();
		pending.set(ask.id, controller);
		const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		const request: ChildPermissionRequest = {
			toolName: ask.toolName,
			toolCallId: ask.toolCallId,
			input: ask.input,
			via: ask.via,
			cwd: options.cwd,
		};
		void (async () => {
			let verdict: ChildPermissionVerdict;
			try {
				options.onAsk?.(request);
				verdict = signal.aborted ? { kind: "cancelled" } : await asker(request, signal);
			} catch {
				verdict = { kind: "unavailable" };
			}
			pending.delete(ask.id);
			try {
				options.onVerdict?.(request, verdict);
			} catch {}
			reply(ask.id, verdict);
		})();
	};

	child.on("message", onMessage);
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			child.off("message", onMessage);
			for (const controller of pending.values()) controller.abort();
			pending.clear();
		},
	};
}
