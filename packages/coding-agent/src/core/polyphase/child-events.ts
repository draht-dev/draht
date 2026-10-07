import type { JsonObject, JsonValue, TextContent, Usage } from "@draht/ai";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { combineUsage } from "../usage-totals.ts";
import {
	type AgentModelInfo,
	type BlockedToolCall,
	type ChildAgentState,
	type ChildStateChange,
	type ChildStateLimits,
	DEFAULT_CHILD_STATE_LIMITS,
	isThinkingLevel,
	type ModelRef,
	NO_UI_APPROVAL_SUFFIX,
	POLYPHASE_RESULT_TOOL_NAME,
	type RunResult,
	type TranscriptItem,
} from "./types.ts";

export interface SessionHeaderRecord {
	type: "session";
	id: string;
	cwd?: string;
	timestamp?: string;
	version?: number;
}

export type ChildWireRecord = SessionHeaderRecord | JsonAgentSessionEvent;

/** JSON.parse in try/catch; returns undefined for malformed lines or values without a string `type`. */
export function parseChildLine(line: string): ChildWireRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	if (typeof (parsed as Record<string, unknown>).type !== "string") return undefined;
	return parsed as ChildWireRecord;
}

const SUMMARY_MAX_CHARS = 120;
const SUMMARY_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url"] as const;
const TOOLCALL_ARG_BUFFER_MAX_CHARS = 2048;
/** Single line, collapsed and ellipsised: a child-supplied error/finalError can be arbitrarily
 * long, and an uncapped notice is the one item kind that can grow larger than a whole run's
 * retention budget on its own (see trimForRetention/evictIfNeeded below). */
const NOTICE_MAX_CHARS = 1000;

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Collapses newlines and runs of whitespace so single-line contracts (summaries, nowLine) hold. */
function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** One line ≤ 120 chars: command | path | file_path | pattern | query | url, else compact JSON. */
export function summarizeToolArgs(_toolName: string, args: JsonValue | undefined): string {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as JsonObject;
		for (const key of SUMMARY_ARG_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) {
				return truncate(collapseWhitespace(value), SUMMARY_MAX_CHARS);
			}
		}
	}
	return truncate(collapseWhitespace(args === undefined ? "" : JSON.stringify(args)), SUMMARY_MAX_CHARS);
}

const STATUS_LINE_PATTERN = /^STATUS:\s*\S.*$/gm;

/** Last line matching /^STATUS:\s*\S.*$/m, trimmed. */
export function extractStatusLine(text: string): string | undefined {
	const matches = text.match(STATUS_LINE_PATTERN);
	if (!matches || matches.length === 0) return undefined;
	return matches[matches.length - 1]?.trim();
}

/** input + output + cacheWrite (cache reads excluded); 0 for undefined. */
export function billableTokens(usage: Usage | undefined): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheWrite;
}

export function createChildAgentState(model: AgentModelInfo): ChildAgentState {
	return {
		lifecycle: "pending",
		activity: "idle",
		model,
		turns: 0,
		toolCalls: 0,
		toolErrors: 0,
		toolCounts: {},
		blocked: [],
		blockedCount: 0,
		transcript: [],
		transcriptChars: 0,
		droppedItems: 0,
		nextSeq: 0,
		nowLine: "",
		finalText: "",
		stderrTail: "",
		malformedLines: 0,
		droppedLines: 0,
		recordsSeen: 0,
		version: 0,
		coarseVersion: 0,
	};
}

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	cancelled: boolean;
	spawnError?: string;
}

export interface ChildFinish {
	exitCode: number;
	failure?: string;
}

type ThinkingItem = Extract<TranscriptItem, { kind: "thinking" }>;
type TextItem = Extract<TranscriptItem, { kind: "text" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

function isTextContent(value: unknown): value is TextContent {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text";
}

/** Shallow guard against a well-typed-looking `message_update`/`message_end` record whose `usage`
 * field is not actually an object (e.g. a string or number from a malformed wire record). */
function isUsageLike(value: unknown): value is Usage {
	return typeof value === "object" && value !== null;
}

function extractResultText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isTextContent(block)) parts.push(block.text);
	}
	return parts.join("");
}

function capHeadTail(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = `\n[... ${text.length - max} characters omitted ...]\n`;
	const keep = Math.max(0, max - marker.length);
	const headLen = Math.floor(keep * 0.4);
	const tailLen = keep - headLen;
	return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
}

/** Last non-empty line of `text`: a streamed thinking/text delta often ends with one or more
 * trailing newlines (a paragraph break), which would otherwise make `nowLine` blank between
 * paragraphs even though the agent is still working. */
function lastLine(text: string): string {
	const trimmed = text.replace(/\s+$/, "");
	const nl = trimmed.lastIndexOf("\n");
	return nl === -1 ? trimmed : trimmed.slice(nl + 1);
}

/** `prefix` plus the collapsed tail of `text`'s last line, kept on one line within `max` chars. */
function clampTail(prefix: string, text: string, max = 160): string {
	const collapsed = collapseWhitespace(lastLine(text));
	const budget = Math.max(0, max - prefix.length);
	const tail = collapsed.length <= budget ? collapsed : collapsed.slice(collapsed.length - budget);
	return `${prefix}${tail}`;
}

/** `head` plus as much of the collapsed `rest` as fits within `max` chars, single line. */
function clampHead(head: string, rest: string, max = 160): string {
	const collapsed = collapseWhitespace(rest);
	// -1 reserves the separator space added below so the result never exceeds `max`.
	const budget = Math.max(0, max - head.length - 1);
	// `truncate` itself slices to `budget`, so pre-slicing to `budget` first (as before) made it a
	// no-op and the ellipsis never appeared; budget === 0 is left empty rather than calling
	// `truncate` with it, since `truncate`'s own minimum output is one char plus an ellipsis.
	const kept = budget > 0 ? truncate(collapsed, budget) : "";
	return kept.length > 0 ? `${head} ${kept}` : head;
}

export class ChildEventReducer {
	readonly state: ChildAgentState;
	private readonly limits: ChildStateLimits;
	private readonly now: () => number;

	private toolItemsById = new Map<string, ToolItem>();
	private openThinking: ThinkingItem | undefined;
	private openText: TextItem | undefined;
	/** Last thinking/text item, kept past `*_end` so `nowLine` shows its final content instead of going blank. */
	private lastThinking: ThinkingItem | undefined;
	private lastText: TextItem | undefined;
	private lastToolItem: ToolItem | undefined;
	private blockedPending: string | undefined;
	private pendingStructuredById = new Map<string, JsonValue>();
	/** Buffered `toolcall_delta` argument JSON per content index, up to `TOOLCALL_ARG_BUFFER_MAX_CHARS` (not surfaced). */
	private toolcallArgBuffers = new Map<number, string>();
	private lastHeartbeatAt = Number.NEGATIVE_INFINITY;

	constructor(init: { model: AgentModelInfo; limits?: Partial<ChildStateLimits>; now?: () => number }) {
		this.limits = { ...DEFAULT_CHILD_STATE_LIMITS, ...init.limits };
		this.now = init.now ?? Date.now;
		this.state = createChildAgentState(init.model);
	}

	markQueued(): ChildStateChange {
		this.state.lifecycle = "queued";
		this.state.queuedAt = this.now();
		return this.bump("coarse");
	}

	markSpawning(): ChildStateChange {
		this.state.lifecycle = "spawning";
		this.state.startedAt = this.now();
		return this.bump("coarse");
	}

	apply(record: ChildWireRecord): ChildStateChange {
		try {
			return this.applyRecord(record);
		} catch {
			this.state.malformedLines++;
			return "none";
		}
	}

	/** For skipped tool_execution_update lines: "fine" at most once per second, else "none". */
	noteHeartbeat(): ChildStateChange {
		const now = this.now();
		if (now - this.lastHeartbeatAt < 1000) return "none";
		this.lastHeartbeatAt = now;
		return this.bump("fine");
	}

	noteStderr(chunk: string): void {
		this.state.stderrTail = (this.state.stderrTail + chunk).slice(-this.limits.maxStderrChars);
	}

	/** Fallback re-spawn: reset everything except queuedAt/startedAt; add an info notice. */
	resetForRetry(model: AgentModelInfo, notice: string): void {
		const queuedAt = this.state.queuedAt;
		const startedAt = this.state.startedAt;
		// version/coarseVersion/nextSeq are monotonic cache keys for pump/store/renderer caches and must
		// never go backwards; everything else from the failed attempt is dropped.
		const version = this.state.version;
		const coarseVersion = this.state.coarseVersion;
		const nextSeq = this.state.nextSeq;
		Object.assign(this.state, createChildAgentState(model));
		// createChildAgentState omits these optional fields rather than setting them to undefined, so
		// Object.assign leaves a stale value behind; clear them explicitly.
		this.state.sessionId = undefined;
		this.state.usage = undefined;
		this.state.liveUsage = undefined;
		this.state.stopReason = undefined;
		this.state.errorMessage = undefined;
		this.state.structured = undefined;
		this.state.retry = undefined;
		this.state.currentTool = undefined;
		this.state.endedAt = undefined;
		this.state.lastEventAt = undefined;
		this.state.queuedAt = queuedAt;
		this.state.startedAt = startedAt;
		this.state.version = version;
		this.state.coarseVersion = coarseVersion;
		this.state.nextSeq = nextSeq;
		// Not in the design's "reset everything except queuedAt/startedAt": createChildAgentState's
		// default ("pending") would otherwise briefly misreport a retry as not-yet-asked-to-run, when
		// a new child process is in fact already being spawned for it.
		this.state.lifecycle = "spawning";
		this.toolItemsById.clear();
		this.openThinking = undefined;
		this.openText = undefined;
		this.lastThinking = undefined;
		this.lastText = undefined;
		this.lastToolItem = undefined;
		this.blockedPending = undefined;
		this.pendingStructuredById.clear();
		this.toolcallArgBuffers.clear();
		this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;
		this.pushNotice("info", notice);
		this.bump("coarse");
	}

	finish(exit: ChildExit): ChildFinish {
		const wasSettled = this.state.lifecycle === "settled";
		this.state.lifecycle = "exited";
		this.state.endedAt = this.now();
		this.blockedPending = undefined;

		// The child stopped sending deltas (cancelled, crashed, or SIGTERM'd mid-stream), but the
		// last-open thinking/text item is still `done: false`. Left alone, the transcript renderer
		// keeps drawing its live cursor (`▌`) on an agent that has already exited.
		if (this.openThinking) {
			this.mutateItem(this.openThinking, (item) => {
				item.done = true;
			});
			this.openThinking = undefined;
		}
		if (this.openText) {
			this.mutateItem(this.openText, (item) => {
				item.done = true;
			});
			this.openText = undefined;
		}

		let exitCode: number;
		let failure: string | undefined;
		if (exit.cancelled) {
			exitCode = 1;
			failure = "cancelled";
		} else if (exit.spawnError) {
			exitCode = 1;
			failure = `failed to start: ${exit.spawnError}`;
		} else if (exit.code === 0 && this.state.stopReason !== "error" && this.state.stopReason !== "aborted") {
			exitCode = 0;
		} else {
			exitCode = 1;
			// §6.4 gives "child exited (code X) before producing output" verbatim for rule 1 and
			// omits a signal from rule 2's wording too; both messages add it here when present,
			// since a SIGTERM/SIGKILL is exactly the kind of detail worth keeping in a failure a
			// user may have to debug, and neither message is pattern-matched downstream.
			const signalSuffix = exit.signal ? `, signal ${exit.signal}` : "";
			if (this.state.recordsSeen === 0) {
				failure = `child exited (code ${exit.code}${signalSuffix}) before producing output`;
			} else if (!wasSettled) {
				failure = `child exited (code ${exit.code}${signalSuffix}) before settling`;
			} else {
				const stopReasonIsFailure = this.state.stopReason === "error" || this.state.stopReason === "aborted";
				failure =
					this.state.errorMessage ??
					(stopReasonIsFailure ? this.state.stopReason : `child exited (code ${exit.code}${signalSuffix})`);
			}
		}

		this.bump("coarse");
		return { exitCode, failure };
	}

	/** After the run finished: keep the newest `maxChars` transcript chars. */
	trimForRetention(maxChars: number): void {
		const transcript = this.state.transcript;
		if (transcript.length === 0) {
			this.state.transcriptChars = 0;
			this.bump("coarse");
			return;
		}

		// The newest item is kept unconditionally, even if it alone is larger than `maxChars`:
		// tail-trimming it still loses only its oldest content, whereas dropping it (the previous
		// behaviour, when `total + size > maxChars` was already true on the first iteration) could
		// empty the whole transcript right after a run whose last item was one huge notice or error.
		const lastIndex = transcript.length - 1;
		const last = transcript[lastIndex] as TranscriptItem;
		this.tailTrimToFit(last, maxChars);

		let total = this.measure(last);
		let cutIndex = lastIndex;
		for (let i = lastIndex - 1; i >= 0; i--) {
			const item = transcript[i];
			if (!item) continue;
			const size = this.measure(item);
			if (total + size > maxChars) {
				cutIndex = i + 1;
				break;
			}
			total += size;
			cutIndex = i;
		}

		if (cutIndex > 0) {
			const removed = transcript.splice(0, cutIndex);
			this.state.droppedItems += removed.length;
			for (const item of removed) {
				if (item.kind === "tool") this.toolItemsById.delete(item.toolCallId);
			}
			this.clearRefsTo(removed);
		}
		this.state.transcriptChars = total;
		this.bump("coarse");
	}

	dropTranscript(): void {
		this.state.droppedItems += this.state.transcript.length;
		this.state.transcript = [];
		this.state.transcriptChars = 0;
		this.toolItemsById.clear();
		this.openThinking = undefined;
		this.openText = undefined;
		this.lastThinking = undefined;
		this.lastText = undefined;
		this.lastToolItem = undefined;
		this.bump("coarse");
	}

	/** Clears open/last item refs that point at an item removed from the transcript. */
	private clearRefsTo(removed: readonly TranscriptItem[]): void {
		const removedSet = new Set<TranscriptItem>(removed);
		if (this.openThinking && removedSet.has(this.openThinking)) this.openThinking = undefined;
		if (this.openText && removedSet.has(this.openText)) this.openText = undefined;
		if (this.lastThinking && removedSet.has(this.lastThinking)) this.lastThinking = undefined;
		if (this.lastText && removedSet.has(this.lastText)) this.lastText = undefined;
		if (this.lastToolItem && removedSet.has(this.lastToolItem)) this.lastToolItem = undefined;
	}

	private applyRecord(record: ChildWireRecord): ChildStateChange {
		switch (record.type) {
			case "session":
				this.state.sessionId = record.id;
				this.state.recordsSeen++;
				return this.bump("coarse");
			case "agent_start":
				this.state.lifecycle = "running";
				this.state.activity = "waiting";
				return this.bump("coarse");
			case "message_start":
				return this.handleMessageStart(record.message);
			case "message_update":
				return this.handleMessageUpdate(record);
			case "message_end":
				return this.handleMessageEnd(record.message);
			case "tool_execution_start":
				return this.handleToolExecutionStart(record);
			case "tool_execution_end":
				return this.handleToolExecutionEnd(record);
			case "auto_retry_start":
				this.state.retry = {
					attempt: record.attempt,
					maxAttempts: record.maxAttempts,
					delayMs: record.delayMs,
					errorMessage: record.errorMessage,
				};
				this.pushNotice("warning", `retrying ${record.attempt}/${record.maxAttempts}: ${record.errorMessage}`);
				this.state.activity = "retrying";
				return this.bump("coarse");
			case "auto_retry_end":
				this.state.retry = undefined;
				this.pushNotice(
					record.success ? "info" : "error",
					record.success ? "retry succeeded" : `retry failed: ${record.finalError ?? ""}`,
				);
				this.state.activity = "idle";
				return this.bump("coarse");
			case "compaction_start":
				this.pushNotice("info", `compacting context (${record.reason})`);
				this.state.activity = "compacting";
				return this.bump("coarse");
			case "compaction_end":
				this.pushNotice(
					record.errorMessage ? "warning" : "info",
					record.errorMessage ? `compaction failed: ${record.errorMessage}` : "compaction finished",
				);
				this.state.activity = "idle";
				return this.bump("coarse");
			case "thinking_level_changed":
				if (!isThinkingLevel(record.level)) return "none";
				this.state.model = { ...this.state.model, thinkingLevel: record.level };
				return this.bump("coarse");
			case "agent_settled":
				this.state.lifecycle = "settled";
				this.state.activity = "idle";
				this.state.currentTool = undefined;
				this.blockedPending = undefined;
				return this.bump("coarse");
			default:
				return "none";
		}
	}

	private handleMessageStart(
		message: Extract<JsonAgentSessionEvent, { type: "message_start" }>["message"],
	): ChildStateChange {
		if (message.role !== "assistant") return "none";
		this.state.turns++;
		if (!this.state.model.confirmed) {
			this.state.model = { ...this.state.model, provider: message.provider, id: message.model, confirmed: true };
		} else if (this.state.model.provider !== message.provider || this.state.model.id !== message.model) {
			this.pushNotice("info", `model switched to ${message.provider}/${message.model}`);
			this.state.model = { ...this.state.model, provider: message.provider, id: message.model, confirmed: true };
		}
		this.state.activity = "waiting";
		return this.bump("coarse");
	}

	private handleMessageEnd(
		message: Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"],
	): ChildStateChange {
		if (message.role !== "assistant") return "none";
		// Read and validate every field that could throw or be the wrong type before mutating
		// anything: a malformed `content` (not an array) must not leave usage/stopReason/errorMessage
		// already written with no version bump, as it would if `.find` threw straight out of this
		// function partway through.
		const content = Array.isArray(message.content) ? message.content : [];
		const textPart = content.find(isTextContent);
		// §6.3 says `model.thinkingLevel = message.thinkingLevel` verbatim; this keeps the previous
		// level instead when the field is absent (or, after hardening, not a valid level), since the
		// child only ever reports it on a subset of messages and overwriting with undefined would
		// otherwise make the live/last-known thinking level flicker to unset between turns.
		const thinkingLevel = isThinkingLevel(message.thinkingLevel)
			? message.thinkingLevel
			: this.state.model.thinkingLevel;
		const usage = isUsageLike(message.usage) ? message.usage : undefined;

		this.state.usage =
			usage === undefined ? this.state.usage : this.state.usage ? combineUsage(this.state.usage, usage) : usage;
		this.state.liveUsage = undefined;
		this.state.model = { ...this.state.model, thinkingLevel };
		this.state.stopReason = message.stopReason;
		this.state.errorMessage = message.errorMessage;
		if (textPart) {
			this.state.finalText = capHeadTail(textPart.text, this.limits.maxFinalTextChars);
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			this.pushNotice(
				"error",
				`assistant turn ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ""}`,
			);
		}
		return this.bump("coarse");
	}

	private handleMessageUpdate(record: Extract<JsonAgentSessionEvent, { type: "message_update" }>): ChildStateChange {
		// Dispatched before `liveUsage` is touched: a bad delta/content type throws out of
		// `applyAssistantMessageEvent` (via appendCapped/replaceCapped below), and that throw must
		// not leave `liveUsage` mutated with no accompanying version bump.
		const change = this.applyAssistantMessageEvent(record.assistantMessageEvent);
		if (isUsageLike(record.usage)) this.state.liveUsage = record.usage;
		return change;
	}

	private applyAssistantMessageEvent(
		event: Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): ChildStateChange {
		switch (event.type) {
			case "thinking_start": {
				const item: ThinkingItem = {
					kind: "thinking",
					seq: this.nextSeq(),
					rev: 1,
					text: "",
					droppedChars: 0,
					done: false,
					redacted: false,
				};
				this.pushItem(item);
				this.openThinking = item;
				this.lastThinking = item;
				this.state.activity = "thinking";
				return this.bump("coarse");
			}
			case "thinking_delta": {
				const item = this.openThinking;
				if (!item) return "none";
				this.mutateItem(item, (i) => this.appendCapped(i, event.delta));
				this.state.activity = "thinking";
				return this.bump("fine");
			}
			case "thinking_end": {
				const item = this.openThinking;
				if (!item) return "none";
				this.mutateItem(item, (i) => {
					this.replaceCapped(i, event.content);
					i.done = true;
					i.redacted = event.content === "[Reasoning redacted]";
				});
				this.openThinking = undefined;
				return this.bump("fine");
			}
			case "text_start": {
				const item: TextItem = {
					kind: "text",
					seq: this.nextSeq(),
					rev: 1,
					text: "",
					droppedChars: 0,
					done: false,
				};
				this.pushItem(item);
				this.openText = item;
				this.lastText = item;
				this.state.activity = "writing";
				return this.bump("coarse");
			}
			case "text_delta": {
				const item = this.openText;
				if (!item) return "none";
				this.mutateItem(item, (i) => this.appendCapped(i, event.delta));
				this.state.activity = "writing";
				return this.bump("fine");
			}
			case "text_end": {
				const item = this.openText;
				if (!item) return "none";
				this.mutateItem(item, (i) => {
					this.replaceCapped(i, event.content);
					i.done = true;
				});
				this.openText = undefined;
				return this.bump("fine");
			}
			case "toolcall_start": {
				const item: ToolItem = {
					kind: "tool",
					seq: this.nextSeq(),
					rev: 1,
					toolCallId: event.id,
					name: event.toolName,
					summary: "",
					status: "pending",
				};
				this.pushItem(item);
				this.toolItemsById.set(event.id, item);
				this.lastToolItem = item;
				this.blockedPending = undefined;
				this.toolcallArgBuffers.set(event.contentIndex, "");
				this.state.activity = "tool";
				return this.bump("coarse");
			}
			case "toolcall_delta": {
				const buffered = this.toolcallArgBuffers.get(event.contentIndex);
				if (buffered !== undefined) {
					this.toolcallArgBuffers.set(
						event.contentIndex,
						(buffered + event.delta).slice(0, TOOLCALL_ARG_BUFFER_MAX_CHARS),
					);
				}
				return "none";
			}
			case "toolcall_end": {
				this.toolcallArgBuffers.delete(event.contentIndex);
				const item = this.toolItemsById.get(event.toolCall.id);
				if (!item) return "none";
				this.mutateItem(item, (i) => {
					i.summary = summarizeToolArgs(event.toolCall.name, event.toolCall.arguments);
				});
				return this.bump("fine");
			}
			default:
				return "none";
		}
	}

	private handleToolExecutionStart(
		event: Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>,
	): ChildStateChange {
		let item = this.toolItemsById.get(event.toolCallId);
		if (!item) {
			item = {
				kind: "tool",
				seq: this.nextSeq(),
				rev: 1,
				toolCallId: event.toolCallId,
				name: event.toolName,
				summary: summarizeToolArgs(event.toolName, event.args as JsonValue | undefined),
				status: "pending",
			};
			this.pushItem(item);
			this.toolItemsById.set(event.toolCallId, item);
		}
		this.lastToolItem = item;
		const startedAt = this.now();
		this.mutateItem(item, (i) => {
			i.status = "running";
			i.startedAt = startedAt;
		});
		this.state.toolCalls++;
		const counts = this.state.toolCounts;
		const prevCount = Object.hasOwn(counts, event.toolName) ? counts[event.toolName] : 0;
		counts[event.toolName] = (prevCount ?? 0) + 1;
		this.state.currentTool = { toolCallId: event.toolCallId, name: event.toolName, summary: item.summary, startedAt };
		this.state.activity = "tool";
		this.blockedPending = undefined;
		if (event.toolName === POLYPHASE_RESULT_TOOL_NAME) {
			this.pendingStructuredById.set(event.toolCallId, event.args as JsonValue);
		}
		return this.bump("coarse");
	}

	private handleToolExecutionEnd(
		event: Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>,
	): ChildStateChange {
		let item = this.toolItemsById.get(event.toolCallId);
		if (!item) {
			item = {
				kind: "tool",
				seq: this.nextSeq(),
				rev: 1,
				toolCallId: event.toolCallId,
				name: event.toolName,
				summary: "",
				status: "pending",
			};
			this.pushItem(item);
			this.toolItemsById.set(event.toolCallId, item);
		}
		const text = extractResultText(event.result);
		const preview = text.slice(0, 200);
		const blocked = event.isError && text.endsWith(NO_UI_APPROVAL_SUFFIX);
		this.mutateItem(item, (i) => {
			i.status = blocked ? "blocked" : event.isError ? "error" : "ok";
			i.endedAt = this.now();
			i.resultPreview = preview;
			if (blocked) i.blockedReason = text;
		});
		if (event.isError) this.state.toolErrors++;
		if (blocked) {
			this.state.blockedCount++;
			const entry: BlockedToolCall = { toolName: event.toolName, summary: item.summary, reason: text };
			this.state.blocked = [...this.state.blocked, entry].slice(-20);
			this.pushNotice("warning", `${event.toolName} blocked: needs approval (subagents cannot ask)`);
			this.blockedPending = event.toolName;
		}
		if (event.toolName === POLYPHASE_RESULT_TOOL_NAME) {
			const pending = this.pendingStructuredById.get(event.toolCallId);
			this.pendingStructuredById.delete(event.toolCallId);
			if (!event.isError && pending !== undefined) {
				this.state.structured = { value: pending };
			}
		}
		this.state.currentTool = undefined;
		return this.bump("coarse");
	}

	private nextSeq(): number {
		return this.state.nextSeq++;
	}

	private pushNotice(level: "info" | "warning" | "error", text: string): void {
		const capped = truncate(collapseWhitespace(text), NOTICE_MAX_CHARS);
		this.pushItem({ kind: "notice", seq: this.nextSeq(), rev: 1, level, text: capped, at: this.now() });
	}

	private pushItem(item: TranscriptItem): void {
		this.state.transcript.push(item);
		this.adjustChars(this.measure(item));
		this.evictIfNeeded();
	}

	private mutateItem<T extends TranscriptItem>(item: T, mutate: (item: T) => void): void {
		const before = this.measure(item);
		mutate(item);
		item.rev++;
		const after = this.measure(item);
		this.adjustChars(after - before);
		this.evictIfNeeded();
	}

	/** `addition` is typed `unknown`, not `string`, on purpose: a well-typed-looking wire record can
	 * still carry a non-string `delta` at runtime (`parseChildLine` only checks `type`), and this
	 * must throw before touching `item.text` rather than let a non-string silently become part of
	 * the transcript or poison `transcriptChars` with a NaN-producing `.length` on a non-string. */
	private appendCapped(item: ThinkingItem | TextItem, addition: unknown): void {
		if (typeof addition !== "string") throw new TypeError("expected a string delta");
		const combined = item.text + addition;
		if (combined.length > this.limits.maxItemChars) {
			const removed = combined.length - this.limits.maxItemChars;
			item.droppedChars += removed;
			item.text = combined.slice(removed);
		} else {
			item.text = combined;
		}
	}

	/** The full item content replaces the accumulated (already tail-capped) text; droppedChars reflects
	 * this final content, not the sum of every delta's cap, so it is assigned rather than accumulated.
	 * `content` is `unknown`, not `string`, for the same reason as {@link appendCapped}'s `addition`. */
	private replaceCapped(item: ThinkingItem | TextItem, content: unknown): void {
		if (typeof content !== "string") throw new TypeError("expected a string content");
		if (content.length > this.limits.maxItemChars) {
			const removed = content.length - this.limits.maxItemChars;
			item.droppedChars = removed;
			item.text = content.slice(removed);
		} else {
			item.droppedChars = 0;
			item.text = content;
		}
	}

	private measure(item: TranscriptItem): number {
		switch (item.kind) {
			case "thinking":
			case "text":
				return item.text.length;
			case "tool":
				return item.summary.length + (item.resultPreview?.length ?? 0);
			case "notice":
				return item.text.length;
		}
	}

	/** Shrinks `item` in place, keeping its tail (most recent content), until `measure(item) <=
	 * maxChars`. Used only to keep the newest transcript item instead of evicting it outright. */
	private tailTrimToFit(item: TranscriptItem, maxChars: number): void {
		const over = this.measure(item) - Math.max(0, maxChars);
		if (over <= 0) return;
		switch (item.kind) {
			case "thinking":
			case "text":
				item.droppedChars += over;
				item.text = item.text.slice(over);
				break;
			case "notice":
				item.text = item.text.slice(over);
				break;
			case "tool": {
				let remaining = over;
				if (item.resultPreview) {
					const trimmed = Math.min(remaining, item.resultPreview.length);
					item.resultPreview = item.resultPreview.slice(trimmed);
					remaining -= trimmed;
				}
				if (remaining > 0) item.summary = item.summary.slice(remaining);
				break;
			}
		}
		item.rev++;
	}

	private adjustChars(delta: number): void {
		const next = this.state.transcriptChars + delta;
		// A NaN delta (impossible for a string's `.length`, but transcriptChars is otherwise an
		// unguarded running total) must not permanently poison the count: Number.isFinite rejects it
		// and leaves the previous value in place instead of letting Math.max(0, NaN) propagate NaN.
		if (Number.isFinite(next)) this.state.transcriptChars = Math.max(0, next);
	}

	private evictIfNeeded(): void {
		const removed: TranscriptItem[] = [];
		while (this.state.transcript.length > this.limits.maxItems || this.state.transcriptChars > this.limits.maxChars) {
			const idx = this.state.transcript.findIndex((item) => !this.isOpenItem(item));
			if (idx === -1) break;
			if (idx === this.state.transcript.length - 1) {
				// This is the only evictable item left (every open item is already exempt, and
				// everything else has already been dropped): tail-trim it instead of dropping it, so
				// one huge item (one notice with a child-supplied error message, say) cannot empty the
				// whole live transcript. Nothing else is left to evict either way, so stop here.
				const item = this.state.transcript[idx] as TranscriptItem;
				const before = this.measure(item);
				this.tailTrimToFit(item, this.limits.maxChars);
				this.adjustChars(this.measure(item) - before);
				break;
			}
			const item = this.state.transcript.splice(idx, 1)[0];
			if (!item) break;
			this.adjustChars(-this.measure(item));
			this.state.droppedItems++;
			if (item.kind === "tool") this.toolItemsById.delete(item.toolCallId);
			removed.push(item);
		}
		if (removed.length > 0) this.clearRefsTo(removed);
	}

	private isOpenItem(item: TranscriptItem): boolean {
		return item === this.openThinking || item === this.openText;
	}

	private bump(change: ChildStateChange): ChildStateChange {
		if (change === "none") return change;
		this.state.version++;
		if (change === "coarse") this.state.coarseVersion++;
		this.state.lastEventAt = this.now();
		this.state.nowLine = this.computeNowLine();
		return change;
	}

	private computeNowLine(): string {
		if (this.blockedPending) {
			return clampHead("⚠", `${this.blockedPending} blocked: needs approval`);
		}
		switch (this.state.activity) {
			case "thinking":
				return clampTail("thinking · ", (this.openThinking ?? this.lastThinking)?.text ?? "");
			case "writing":
				return clampTail("writing · ", (this.openText ?? this.lastText)?.text ?? "");
			case "tool": {
				const item = this.lastToolItem;
				return item ? clampHead(item.name, item.summary) : "";
			}
			case "waiting":
				return "waiting for model";
			case "retrying": {
				const retry = this.state.retry;
				return retry
					? clampHead(`retrying ${retry.attempt}/${retry.maxAttempts} ·`, retry.errorMessage)
					: "retrying";
			}
			case "compacting":
				return "compacting context";
			case "idle":
				return this.state.lifecycle === "settled" ? "finished" : "";
			default:
				return "";
		}
	}
}

function resolveModelRef(state: Readonly<ChildAgentState>): ModelRef | undefined {
	if (!state.model.confirmed || !state.model.provider || !state.model.id) return undefined;
	return { provider: state.model.provider, id: state.model.id };
}

export function toRunResult(
	state: Readonly<ChildAgentState>,
	base: { agent: string; task: string; step?: number },
	finish: ChildFinish,
	extras: { cancelled: boolean; structured?: { value: JsonValue }; durationMs: number },
): RunResult {
	const failedResponse = state.stopReason === "error" || state.stopReason === "aborted";
	const stderr =
		state.stderrTail.length > 0
			? state.stderrTail
			: failedResponse
				? (state.errorMessage ?? state.stopReason ?? "")
				: (finish.failure ?? "");

	return {
		agent: base.agent,
		task: base.task,
		step: base.step,
		exitCode: finish.exitCode,
		output: state.finalText,
		stderr,
		usage: state.usage,
		model: resolveModelRef(state),
		thinkingLevel: state.model.thinkingLevel,
		stopReason: state.stopReason,
		turns: state.turns,
		toolCalls: state.toolCalls,
		blockedToolCalls: state.blockedCount,
		structured: extras.structured,
		cancelled: extras.cancelled,
		durationMs: extras.durationMs,
	};
}
