/**
 * Subagent Tool for Draht — adapted from the pi subagent example
 *
 * Spawns isolated draht processes for delegated tasks.
 * Agents are defined in .draht/agents/*.md (project) or ~/.draht/agent/agents/*.md (global).
 *
 * Modes:
 *   single   — { agent, task }
 *   parallel — { tasks: [{ agent, task }] }  (max 8, concurrency 4)
 *   chain    — { chain: [{ agent, task }] }  (sequential, {previous} placeholder)
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "../../config.js";
import { comparablePath, realPathStrict } from "../../utils/canonical-path.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	PermissionAskDetail,
	ToolCallEvent,
	ToolCallEventResult,
} from "../extensions/types.js";
import {
	AgentFSM,
	type AgentFSMTransitionEvent,
	isPermissionMode,
	loadRules,
	type Message as MailboxMessage,
	MailboxSystem,
	PERMISSION_MODES,
	PermissionGate,
	type PermissionMode,
	type PermissionRule,
	parseRules,
	TaskBoard,
	WorktreeIsolator,
} from "../multi-agent/index.ts";
import { type ApprovalDescription, describeToolCallForApproval } from "../polyphase/approval.ts";
import { createProcessAgentRunner } from "../polyphase/child-process.ts";
import { buildDetails, sumRunUsage } from "../polyphase/details.ts";
import { createPartialUpdateEmitter } from "../polyphase/emitter.ts";
import { type AgentLimiter, LimiterAbortedError, type LimiterLease } from "../polyphase/limiter.ts";
import { resolveChildModel } from "../polyphase/model-selection.ts";
import { createSubagentRenderers, type PolyphaseRenderDeps } from "../polyphase/render/renderers.ts";
import { capHeadTail, formatSubagentResultText } from "../polyphase/result-text.ts";
import { disposePolyphaseSession, getPolyphaseSession, peekPolyphaseSession } from "../polyphase/session.ts";
import { resolvePolyphaseSettings } from "../polyphase/settings.ts";
import type { AgentConfig, AgentRunContext, AgentRunner, ProgressFn, RunResult } from "../polyphase/types.ts";
import {
	currentPolyphaseDepth,
	NO_UI_APPROVAL_SUFFIX,
	THINKING_LEVELS,
	WORKFLOW_TOOL_NAME,
} from "../polyphase/types.ts";
import { boundedSafeText } from "../socket-server/safe-text.js";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;

// ─── Multi-agent coordination primitives ───────────────────────────────────
//
// Shared, module-scoped instances backing every subagent run in this process:
// each run (single task, one parallel item, one chain step) gets its own
// AgentFSM + mailbox for the duration of the run, task board entries track
// parallel-mode assignments, and worktree isolation is opt-in per call.

/** Mailbox address subagent runs deliver their `TaskResult`/`Abort` message to by default. */
export const SUBAGENT_RESULT_MAILBOX = "subagent-results";

const mailboxSystem = new MailboxSystem();
const taskBoard = new TaskBoard();
const worktreeIsolator = new WorktreeIsolator();
mailboxSystem.register(SUBAGENT_RESULT_MAILBOX);

const fsmTransitionListeners = new Set<(event: AgentFSMTransitionEvent) => void>();

/** Observe FSM transitions across every subagent run in this process. Returns an unsubscribe function. */
export function onAgentFsmTransition(listener: (event: AgentFSMTransitionEvent) => void): () => void {
	fsmTransitionListeners.add(listener);
	return () => fsmTransitionListeners.delete(listener);
}

/** Test/orchestrator-facing handles onto the shared multi-agent primitives backing this module. */
export const multiAgentState = {
	mailbox: mailboxSystem,
	board: taskBoard,
	worktree: worktreeIsolator,
};

export type { AgentConfig, AgentRunContext, AgentRunner, ProgressFn, RunResult } from "../polyphase/types.ts";

// ─── Agent discovery ────────────────────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		try {
			const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name || !frontmatter.description) continue;
			const tools = frontmatter.tools
				?.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean);
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools?.length ? tools : undefined,
				model: frontmatter.model,
				systemPrompt: body,
				source,
			});
		} catch {}
	}
	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	// The gate's own chain, from the raw spelling: `resolvePath` first would collapse `..`
	// lexically, and a cwd that will not resolve has unknown ancestors to load from.
	const realCwd = realPathStrict(cwd);
	if (realCwd === undefined) return null;
	let dir = realCwd;
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

type AgentScope = "user" | "project" | "both";

export function discoverAgents(cwd: string, scope: AgentScope, projectTrusted: boolean): AgentConfig[] {
	// Shipped agents (bundled with the package) — lowest priority
	const shippedDir = path.join(getPackageDir(), "agents");
	const shippedAgents = loadAgentsFromDir(shippedDir, "user");

	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = projectTrusted ? findProjectAgentsDir(cwd) : null;
	const userAgents = scope !== "project" ? loadAgentsFromDir(userDir, "user") : [];
	const projectAgents = scope !== "user" && projectDir ? loadAgentsFromDir(projectDir, "project") : [];

	// Priority: shipped < user < project
	const map = new Map<string, AgentConfig>();
	for (const a of shippedAgents) map.set(a.name, a);
	for (const a of userAgents) map.set(a.name, a);
	for (const a of projectAgents) map.set(a.name, a);
	return Array.from(map.values());
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const defaultRunner: AgentRunner = createProcessAgentRunner();

/** Converts an item's own exception into a failed `RunResult` so one bad item never aborts the rest. */
async function runParallel<T extends { agent: AgentConfig; task: string }>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<RunResult>,
): Promise<RunResult[]> {
	const results: RunResult[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				try {
					results[i] = await fn(items[i], i);
				} catch (error) {
					results[i] = {
						agent: items[i].agent.name,
						task: items[i].task,
						exitCode: 1,
						output: "",
						stderr: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}),
	);
	return results;
}

// ─── Multi-agent orchestration ─────────────────────────────────────────────
//
// Wraps the process runner (`defaultRunner`, or a pluggable `AgentRunner` for tests) with the
// multi-agent coordination primitives: an AgentFSM tracks each run's
// IDLE→REQUEST→WORKING→RESPOND→IDLE lifecycle, a mailbox delivers the run's
// TaskResult (or Abort on failure) to an interested recipient, and worktree
// isolation is applied opt-in per run. Parallel mode additionally posts each
// task to the shared TaskBoard so agents "self-assign" work; chain mode
// relays `{previous}` between steps via a per-chain mailbox instead of a bare
// local variable.

/** `{agent, task, exitCode: 1, output: "", stderr: "cancelled", cancelled: true, step}` (§10.1). */
function cancelledResult(agentName: string, task: string, step: number | undefined): RunResult {
	return { agent: agentName, task, exitCode: 1, output: "", stderr: "cancelled", cancelled: true, step };
}

interface LifecycleOptions {
	signal?: AbortSignal;
	step?: number;
	onProgress?: ProgressFn;
	/** Stable id for this run's FSM + mailbox. */
	agentId: string;
	/** Mailbox address the completion message is delivered to. Defaults to `SUBAGENT_RESULT_MAILBOX`. */
	resultMailbox?: string;
	/** Opt-in git worktree isolation for this run. */
	worktree?: boolean;
	/** Task id used for worktree keying. Defaults to `agentId`. */
	taskId?: string;
	/** Process runner to use. Defaults to `defaultRunner`. */
	runner?: AgentRunner;
	/** Session-wide child-process gate; a lease is held only around this run's child process, never
	 *  by orchestrators (§8.1). */
	limiter?: AgentLimiter;
	/** Options threaded straight to the process runner (model, thinking, live-state sink, lifecycle callbacks). */
	run?: AgentRunContext;
}

/**
 * Runs one agent task through the full multi-agent lifecycle: a pre-abort check, an optional
 * limiter lease, FSM transitions around the run, opt-in worktree isolation, and a mailbox message
 * on completion. This is the single point every orchestration mode (single/parallel/chain) below
 * funnels through.
 *
 * A signal already aborted before (or while queued for) a limiter slot short-circuits to a
 * cancelled result without running the FSM or spawning — but `run.onFinish` still fires, since
 * `LiveAgent.createRunContext()` depends on it to leave "queued"/"pending" and settle.
 */
async function runAgentWithLifecycle(
	cwd: string,
	agent: AgentConfig,
	task: string,
	opts: LifecycleOptions,
): Promise<RunResult> {
	const {
		agentId,
		resultMailbox = SUBAGENT_RESULT_MAILBOX,
		worktree,
		taskId = agentId,
		runner = defaultRunner,
		limiter,
		run,
	} = opts;

	if (opts.signal?.aborted) {
		const result = cancelledResult(agent.name, task, opts.step);
		run?.onFinish?.(result);
		return result;
	}

	let lease: LimiterLease | undefined;
	if (limiter) {
		try {
			lease = await limiter.acquire({ signal: opts.signal, onQueued: run?.onQueued });
		} catch (error) {
			// Any acquire rejection — aborted-while-queued or e.g. `limiter.rejectAll()` on session
			// teardown — must resolve to a RunResult and fire `onFinish` exactly once rather than
			// escape as a rejection, since callers (and `LiveAgent`) depend on both.
			const result =
				error instanceof LimiterAbortedError
					? cancelledResult(agent.name, task, opts.step)
					: {
							agent: agent.name,
							task,
							exitCode: 1,
							output: "",
							stderr: error instanceof Error ? error.message : String(error),
							step: opts.step,
						};
			run?.onFinish?.(result);
			return result;
		}
	}

	const fsm = new AgentFSM(agentId);
	const forward = (event: AgentFSMTransitionEvent) => {
		for (const listener of fsmTransitionListeners) {
			try {
				listener(event);
			} catch {
				// A throwing observer must not skip the lease release or mailbox cleanup below.
			}
		}
	};
	fsm.onTransition(forward);
	mailboxSystem.register(agentId);

	fsm.transition("REQUEST");
	fsm.transition("WORKING");

	let effectiveCwd = cwd;
	let usedWorktree = false;
	let result: RunResult;
	try {
		if (opts.signal?.aborted) {
			result = cancelledResult(agent.name, task, opts.step);
		} else {
			if (worktree) {
				effectiveCwd = worktreeIsolator.create(cwd, taskId);
				// effectiveCwd === cwd means create() fell back to cwd outside a git repo, where
				// merge(taskId)/cleanup(taskId) would fabricate a failure for the unknown taskId.
				usedWorktree = effectiveCwd !== cwd;
			}
			result = await runner(effectiveCwd, agent, task, opts.signal, opts.step, opts.onProgress, run);
			if (usedWorktree && result.exitCode === 0) {
				result.merge = worktreeIsolator.merge(taskId);
			}
		}
	} catch (error) {
		result = {
			agent: agent.name,
			task,
			exitCode: 1,
			output: "",
			stderr: error instanceof Error ? error.message : String(error),
			step: opts.step,
		};
	} finally {
		if (usedWorktree) {
			try {
				worktreeIsolator.cleanup(taskId);
			} catch {
				// Best-effort teardown; a failed cleanup must not mask the run's real result.
			}
		}
		lease?.release();
	}

	fsm.transition("RESPOND");
	mailboxSystem.send<RunResult>(agentId, resultMailbox, {
		type: result.exitCode === 0 ? "TaskResult" : "Abort",
		payload: result,
	});
	fsm.transition("IDLE");

	if (agentId !== resultMailbox) {
		mailboxSystem.deregister(agentId);
	}

	run?.onFinish?.(result);
	return result;
}

export interface RunSingleTaskOptions {
	signal?: AbortSignal;
	onProgress?: ProgressFn;
	worktree?: boolean;
	runner?: AgentRunner;
	agentId?: string;
	resultMailbox?: string;
	limiter?: AgentLimiter;
	run?: AgentRunContext;
}

/** Single-mode orchestration: one agent, one task, one FSM/mailbox lifecycle. */
export async function runSingleTask(
	cwd: string,
	agent: AgentConfig,
	task: string,
	opts: RunSingleTaskOptions = {},
): Promise<RunResult> {
	const agentId = opts.agentId ?? `single-${randomUUID()}`;
	return runAgentWithLifecycle(cwd, agent, task, {
		signal: opts.signal,
		onProgress: opts.onProgress,
		worktree: opts.worktree,
		runner: opts.runner,
		resultMailbox: opts.resultMailbox,
		limiter: opts.limiter,
		run: opts.run,
		agentId,
		taskId: agentId,
	});
}

export interface RunParallelTasksOptions {
	signal?: AbortSignal;
	makeOnProgress?: (agentName: string) => ProgressFn;
	worktree?: boolean;
	runner?: AgentRunner;
	resultMailbox?: string;
	limiter?: AgentLimiter;
	/** Per-item signal/run overrides. Falls back to `opts.signal`/no run context when absent. */
	perItem?: (index: number) => { signal?: AbortSignal; run?: AgentRunContext };
}

/**
 * Parallel-mode orchestration: every task is posted to the shared TaskBoard
 * up front (with `{ agentType: agent.name }` requirements), then atomically
 * assigned to its corresponding worker. Direct assignment keeps concurrent
 * orchestration calls from claiming one another's same-role tasks.
 *
 * The pool is `items.length` when `limiter` is given — the limiter itself is what bounds real
 * concurrency — else `MAX_CONCURRENCY`.
 */
export async function runParallelTasks(
	cwd: string,
	items: Array<{ agent: AgentConfig; task: string }>,
	opts: RunParallelTasksOptions = {},
): Promise<RunResult[]> {
	const postedIds = items.map((item) =>
		taskBoard.post({ requirements: { agentType: item.agent.name }, description: item.task }),
	);
	const concurrency = opts.limiter ? items.length : MAX_CONCURRENCY;

	return runParallel(items, concurrency, async (item, i) => {
		const workerId = `parallel-${i}-${randomUUID()}`;
		const taskId = postedIds[i];
		const assignment = taskBoard.assign(taskId, workerId);
		if (!assignment.ok) throw new Error(assignment.error);

		// A throw anywhere below — `perItem(i)` or `runAgentWithLifecycle` itself — must still fail
		// the posted task; otherwise it stays `assigned` forever (`runParallel`'s own catch turns the
		// throw into a failed RunResult, but never touches the board).
		try {
			const perItem = opts.perItem?.(i);
			const result = await runAgentWithLifecycle(cwd, item.agent, item.task, {
				signal: perItem?.signal ?? opts.signal,
				onProgress: opts.makeOnProgress?.(item.agent.name),
				worktree: opts.worktree,
				runner: opts.runner,
				resultMailbox: opts.resultMailbox,
				limiter: opts.limiter,
				run: perItem?.run,
				agentId: workerId,
				taskId,
			});

			if (result.exitCode === 0) taskBoard.complete(taskId, capHeadTail(result.output, 4096).text);
			else taskBoard.fail(taskId, capHeadTail(result.stderr || result.output || "subagent task failed", 4096).text);

			return result;
		} catch (error) {
			taskBoard.fail(taskId, capHeadTail(error instanceof Error ? error.message : String(error), 4096).text);
			throw error;
		}
	});
}

export interface RunChainTasksOptions {
	signal?: AbortSignal;
	makeOnProgress?: (agentName: string) => ProgressFn;
	worktree?: boolean;
	runner?: AgentRunner;
	/** Called before each step starts, e.g. to report "step i/total" progress. */
	onBeforeStep?: (index: number, total: number, agentName: string) => void;
	limiter?: AgentLimiter;
	/** Per-step signal/run overrides. Falls back to `opts.signal`/no run context when absent. */
	perItem?: (index: number) => { signal?: AbortSignal; run?: AgentRunContext };
}

/**
 * Chain-mode orchestration: steps run sequentially, each with its own FSM.
 * `{previous}` is resolved from a per-chain relay mailbox that each step's
 * TaskResult is delivered to — not a bare local variable — so downstream
 * steps consume the prior step's output the same way any other mailbox
 * message-passing consumer would. Stops (without throwing) at the first
 * step that did not exit 0 (failed or cancelled); that result is still
 * included as the last entry.
 */
export async function runChainTasks(
	cwd: string,
	steps: Array<{ agent: AgentConfig; task: string }>,
	opts: RunChainTasksOptions = {},
): Promise<RunResult[]> {
	const chainMailbox = `chain-relay-${randomUUID()}`;
	mailboxSystem.register(chainMailbox);

	const results: RunResult[] = [];
	let previous = "";

	try {
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			opts.onBeforeStep?.(i, steps.length, step.agent.name);

			const stepAgentId = `chain-${i}-${randomUUID()}`;
			// A function replacer: `previous` may itself contain `$&`/`$1`-shaped text, which a
			// string replacement would reinterpret as a back-reference instead of inserting literally.
			const task = step.task.replace(/\{previous\}/g, () => previous);
			const perItem = opts.perItem?.(i);

			const result = await runAgentWithLifecycle(cwd, step.agent, task, {
				signal: perItem?.signal ?? opts.signal,
				step: i + 1,
				onProgress: opts.makeOnProgress?.(step.agent.name),
				worktree: opts.worktree,
				runner: opts.runner,
				resultMailbox: chainMailbox,
				limiter: opts.limiter,
				run: perItem?.run,
				agentId: stepAgentId,
				taskId: stepAgentId,
			});

			results.push(result);
			if (result.exitCode !== 0) break;

			const delivered = mailboxSystem.drain(chainMailbox);
			const taskResult = [...delivered].reverse().find((m) => m.type === "TaskResult" && m.from === stepAgentId) as
				| MailboxMessage<RunResult>
				| undefined;
			previous = taskResult?.payload?.output ?? result.output;
		}
	} finally {
		mailboxSystem.deregister(chainMailbox);
	}

	return results;
}

export interface RunMailbox {
	readonly name: string;
	dispose(): void;
}

/** Registers `${prefix}-${randomUUID()}`; `dispose` drains and deregisters it (idempotent). */
export function createRunMailbox(prefix: string): RunMailbox {
	const name = `${prefix}-${randomUUID()}`;
	mailboxSystem.register(name);
	let disposed = false;
	return {
		name,
		dispose() {
			if (disposed) return;
			disposed = true;
			mailboxSystem.drain(name);
			mailboxSystem.deregister(name);
		},
	};
}

/** Grapheme budget for every attacker-influenced string that travels in a permission ask. */
const PERMISSION_DETAIL_MAX_GRAPHEMES = 512;

/**
 * Byte budget for the same strings, stated HERE and not left to the default, because this is the
 * producer whose output has to fit a frame: one grapheme cluster admits unboundedly many combining
 * marks, so 512 clusters of Zalgo weighed 383,246 bytes until this bound existed — accepted by the
 * schema, then refused by the attach bridge, which closed the renderer's socket with 1008.
 *
 * 512 × 4 bytes: four is the widest a single code point is in UTF-8, so every ordinary cluster
 * survives untouched. A `tool_permission` detail carries FIVE such scalar fields — `toolCallId`,
 * `toolName`, `cwd`, `reason`, and exactly one of `command` / `path` / `operation` — plus up to
 * `MAX_SUMMARY_LINES` lines of `summary`, so at maximum it is (5 + MAX_SUMMARY_LINES) × 2048 bytes
 * of free text plus a fixed option pair and a handful of keys, comfortably under the 64 KiB
 * `maxFrameBytes` a permission frame must fit into, which is never split.
 */
const PERMISSION_DETAIL_MAX_BYTES = 512 * 4;

/** Caps the lines an {@link ApprovalDescription} can add to a permission ask's `summary`. */
const MAX_SUMMARY_LINES = 8;

/**
 * The vocabulary this phase offers for a tool permission ask.
 *
 * Frozen and shared: the same object identity is handed to every surface, so no renderer can
 * quietly widen or reorder it. Each option states its OWN decision — nothing may infer approval
 * from an option's position, id, or the array's length.
 */
const TOOL_PERMISSION_OPTIONS: readonly { id: string; label: string; decision: "approve" | "deny" }[] = Object.freeze([
	Object.freeze({ id: "approve", label: "Yes", decision: "approve" as const }),
	Object.freeze({ id: "deny", label: "No", decision: "deny" as const }),
]);

/** Accumulates the elision verdicts of every field of one detail. */
interface ElisionVerdict {
	truncated: boolean;
}

/**
 * Neutralize-and-bound a single wire-bound string — in clusters AND bytes — RECORDING the verdict.
 *
 * `verdict` is a required parameter and not an optional convenience: this function used to return
 * `boundedSafeText(...).value` and nothing else, and every caller silently dropped `.truncated`.
 * Making the accumulator part of the signature is what stops a new field being added tomorrow that
 * elides in silence — there is no way to call this and not answer the question.
 */
function safeField(raw: string, verdict: ElisionVerdict): string {
	const bounded = boundedSafeText(raw, PERMISSION_DETAIL_MAX_GRAPHEMES, PERMISSION_DETAIL_MAX_BYTES);
	if (bounded.truncated) verdict.truncated = true;
	// `bounded.originalLength` is deliberately NOT carried: `PermissionRequestFrameSchema` in
	// packages/geist-protocol/src/wire.ts has no field for it, so putting it on the detail would
	// produce a number that reaches no wire. The elision marker inside `value` already names the
	// count, which is how a surface recovers the original length today.
	return bounded.value;
}

/**
 * Build the canonical detail for a tool permission ask.
 *
 * Neutralization happens HERE, at construction, not at any protocol layer: three renderers
 * (TUI, `draht --attach`, RPC) inherit this object, and the attach client is a bare `JSON.parse`
 * cast that never passes through a schema. Constructing it safe is what makes all three safe.
 *
 * `description`, when given, carries the workflow approval's own title/message/operation. Its
 * `operation` replaces the command/path/operation inference below outright: a workflow call's
 * free-text `script`/`args` fields are not themselves what a human needs to approve, the parsed
 * phase summary is. Its `message` becomes `detail.summary` — rows ahead of `toolName`/`cwd`/
 * `reason` — so the description is never dropped on a renderer that only knows `detail` (§15).
 * `summary` itself reaches the TUI and an RPC client (the three renderers above inherit this same
 * object), but not `draht --attach` or geist: `socket-server/permission-relay.ts`'s
 * `buildRequestFrame` hand-builds that wire frame and has no field for it (see
 * `PermissionAskDetail.summary`'s doc).
 */
function buildPermissionAskDetail(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	reason: string,
	description?: ApprovalDescription,
): PermissionAskDetail {
	const input = (event.input ?? {}) as Record<string, unknown>;
	const verdict: ElisionVerdict = { truncated: false };
	const detail: PermissionAskDetail = {
		kind: "tool_permission",
		toolCallId: safeField(event.toolCallId, verdict),
		toolName: safeField(event.toolName, verdict),
		// `ctx.cwd` is the raw, un-normalised `config.cwd`; a symlinked worktree would otherwise
		// read as a different project on the answering surface.
		cwd: safeField(comparablePath(ctx.cwd), verdict),
		reason: safeField(reason, verdict),
		options: TOOL_PERMISSION_OPTIONS,
		truncated: false,
	};

	if (description !== undefined) {
		detail.summary = description.message
			.split("\n")
			.slice(0, MAX_SUMMARY_LINES)
			.map((line) => safeField(line, verdict));
	}

	if (description?.operation !== undefined) {
		detail.operation = safeField(description.operation, verdict);
	} else {
		const command = typeof input.command === "string" ? input.command : undefined;
		const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
		const plainPath = typeof input.path === "string" ? input.path : undefined;

		if (command !== undefined) {
			detail.command = safeField(command, verdict);
		} else if (filePath !== undefined || plainPath !== undefined) {
			detail.path = safeField((filePath ?? plainPath) as string, verdict);
		} else {
			// Every extension tool takes `Record<string, unknown>`, so there is always SOMETHING to
			// show. Serializing the whole argument object beats an empty ask that asks the human to
			// approve an unknown action.
			detail.operation = safeField(serializeToolInput(input), verdict);
		}
	}

	// Set LAST: the branches above are the fields most likely to be elided, and the override is
	// assigned after the literal. Reading `verdict` any earlier reports on a partial detail.
	detail.truncated = verdict.truncated;

	return detail;
}

/** JSON-serialize a tool's argument object, degrading to a readable form rather than throwing. */
function serializeToolInput(input: Record<string, unknown>): string {
	try {
		return JSON.stringify(input) ?? String(input);
	} catch {
		// Cyclic or otherwise unserializable input must not crash the permission gate.
		return Object.keys(input).join(", ");
	}
}

const PERMISSION_RULES_FILE = "permissions.yml";

export function loadPermissionRules(projectDir: string, projectTrusted: boolean, globalDir?: string): PermissionRule[] {
	if (projectTrusted) {
		return loadRules(projectDir, globalDir);
	}
	// Not loadRules(projectDir=undefined): that default is process.cwd(), i.e. the untrusted project itself.
	const globalRulesPath = path.join(globalDir ?? getAgentDir(), PERMISSION_RULES_FILE);
	return fs.existsSync(globalRulesPath) ? parseRules(fs.readFileSync(globalRulesPath, "utf-8")) : [];
}

/** Hook points `createPermissionGateToolCallHandler` offers to its caller (§10.5). */
export interface PermissionGateHandlerOptions {
	/** Called only for `approve` decisions. Must be cheap and must not throw. */
	describe?: (event: ToolCallEvent, ctx: ExtensionContext) => ApprovalDescription | undefined;
	/** Called right before `ctx.ui.confirm` (so an open inspector can close first). */
	beforePrompt?: (ctx: ExtensionContext) => void;
}

/**
 * Permission-gate hook point: builds a `tool_call` handler that consults a
 * `PermissionGate` before a tool executes. `deny` blocks the call outright;
 * `approve` requires interactive confirmation (blocking when no UI is
 * available, fail-safe); `allow` lets the call proceed unmodified. Ready to
 * `pi.on("tool_call", ...)` — this prepares the wiring point without forcing
 * every tool call in the process through it by default.
 */
export function createPermissionGateToolCallHandler(
	gate: PermissionGate,
	options?: PermissionGateHandlerOptions,
): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined> {
	return async (event, ctx) => {
		const decision = gate.evaluate(event.toolName, event.input as Record<string, unknown>);

		if (decision.action === "deny") {
			return { block: true, reason: decision.reason };
		}

		if (decision.action === "approve") {
			// No answering surface at all: keep today's loud, operator-facing block verbatim rather
			// than letting a no-op UI resolve `false` and be recorded as a user's denial.
			if (!ctx.hasUI) {
				return { block: true, reason: `${decision.reason} ${NO_UI_APPROVAL_SUFFIX}` };
			}

			const description = options?.describe?.(event, ctx);
			// Called right before the prompt, so an open inspector closes and the parent dialog
			// stays reachable.
			options?.beforePrompt?.(ctx);

			const detail = buildPermissionAskDetail(event, ctx, decision.reason, description);
			const title = description?.title ?? "Approve tool call?";
			const message = description
				? `${description.message}\n\n${decision.reason}`
				: `${event.toolName}: ${decision.reason}`;

			// Both positional strings are unchanged so every existing renderer keeps working; the
			// canonical facts ride alongside them for surfaces that can render structure.
			//
			// `signal` is the turn's OWN abort signal, read live off the context (it is the active
			// run's controller, minted fresh per run, so it is never a stale aborted one). A
			// permission ask that inherits "wait forever" with no way to be dismissed is its own
			// hazard: this ask parks the agent loop inside `beforeToolCall`, and before this the
			// only things that could end it were a human answering and the relay's own backstop
			// clock. Aborting the turn now takes the dialog down on every surface, and — because
			// nobody answered — it is recorded as `cancelled` by the system rather than as this
			// human's refusal.
			const approved = await ctx.ui.confirm(title, message, { detail, signal: ctx.signal });
			if (!approved) {
				// The turn being aborted is NOT a refusal, and saying so in the transcript would put the
				// same fabrication in front of the model that the durable record was just cleared of:
				// the JSONL reads `cancelled` by `system`, so the reason the model sees must not read
				// `User denied approval`. This branch became reachable the moment `signal` started being
				// passed above — before that, an abort could not end an ask at all.
				if (ctx.signal?.aborted) {
					return { block: true, reason: "the turn was aborted before this call was approved" };
				}
				return { block: true, reason: "User denied approval" };
			}
			return undefined;
		}

		return undefined;
	};
}

// ─── Extension ──────────────────────────────────────────────────────────────

const ThinkingParam = Type.Union(
	THINKING_LEVELS.map((level) => Type.Literal(level)),
	{
		description: "Thinking level for this agent",
	},
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task description" }),
	label: Type.Optional(Type.String({ description: "Short display label (default: agent name, #n for duplicates)" })),
	model: Type.Optional(
		Type.String({
			description: "provider/id[:thinking]; default: agent frontmatter model, else the current session model",
		}),
	),
	thinking: Type.Optional(ThinkingParam),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task, optionally using {previous} placeholder" }),
	label: Type.Optional(Type.String({ description: "Short display label (default: agent name, #n for duplicates)" })),
	model: Type.Optional(
		Type.String({
			description: "provider/id[:thinking]; default: agent frontmatter model, else the current session model",
		}),
	),
	thinking: Type.Optional(ThinkingParam),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	label: Type.Optional(Type.String({ description: "Short display label (single mode)" })),
	model: Type.Optional(
		Type.String({
			description: "provider/id[:thinking] (single mode); default: agent frontmatter model, else current",
		}),
	),
	thinking: Type.Optional(ThinkingParam),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chained tasks" })),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], { default: "both" }),
	),
	worktree: Type.Optional(
		Type.Boolean({ description: "Opt-in: run each task in an isolated git worktree, merged back on success" }),
	),
});

type EmptyDetails = Record<string, never>;

interface LabeledItem {
	agent: AgentConfig;
	label?: string;
}

/** A blank or whitespace-only label is treated as absent, not as the literal empty string. */
function labelKey(item: LabeledItem): string {
	const trimmed = item.label?.trim();
	return trimmed ? trimmed : item.agent.name;
}

/**
 * Default label is the agent name; duplicates (whether default or user-provided) become
 * `<key>#1`, `<key>#2`, in order. Every emitted label is tracked across the whole call, so a
 * user-provided label that collides with a number this function would otherwise generate (e.g.
 * `["reviewer#1", default, default]` for three `reviewer` tasks) still comes out unique.
 */
function assignLabels(items: readonly LabeledItem[]): string[] {
	const totals = new Map<string, number>();
	for (const item of items) {
		const key = labelKey(item);
		totals.set(key, (totals.get(key) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	const emitted = new Set<string>();
	return items.map((item) => {
		const key = labelKey(item);
		let label = (totals.get(key) ?? 0) <= 1 ? key : undefined;
		if (label === undefined || emitted.has(label)) {
			let n = (seen.get(key) ?? 0) + 1;
			label = `${key}#${n}`;
			while (emitted.has(label)) {
				n++;
				label = `${key}#${n}`;
			}
			seen.set(key, n);
		}
		emitted.add(label);
		return label;
	});
}

/**
 * Human-readable recovery notice for a failed worktree merge-back, or
 * `undefined` when no merge was attempted or it succeeded. The branch name,
 * the literal `git merge <branch>` command, and the word "resolve-conflicts"
 * are the contract callers (and tests) rely on.
 */
export function describeMergeFailure(result: RunResult): string | undefined {
	if (!result.merge || result.merge.success) return undefined;
	const branch = result.merge.branch ?? "agent/<taskId>";
	const conflicts = result.merge.conflicts?.length ? ` Conflicting paths: ${result.merge.conflicts.join(", ")}.` : "";
	return (
		`Worktree merge-back FAILED: the agent's work is committed on the unmerged branch "${branch}" ` +
		`and is NOT in the working tree.${conflicts} To integrate it, run \`git merge ${branch}\`, ` +
		`then invoke the resolve-conflicts skill (/resolve-conflicts) to resolve the conflicts and finish the merge.`
	);
}

/** `createSubagentExtension(options?)`; the default export is `createSubagentExtension()` (§10.5). */
export function createSubagentExtension(options: { runner?: AgentRunner } = {}): (pi: ExtensionAPI) => void {
	const runnerOverride = options.runner;

	return (pi: ExtensionAPI) => {
		// Autocomplete gets no ctx, so the last trust answer a ctx gave for this cwd stands in; unseen cwds count as untrusted.
		let lastProjectTrust: { cwd: string; trusted: boolean } | undefined;
		const noteProjectTrust = (ctx: ExtensionContext) => {
			lastProjectTrust = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
		};
		const rememberedProjectTrust = (cwd: string): boolean =>
			lastProjectTrust?.cwd === cwd ? lastProjectTrust.trusted : false;

		let currentSession: ReturnType<typeof getPolyphaseSession> | undefined;

		const renderDeps: PolyphaseRenderDeps = {
			getStore: () => currentSession?.store,
			viewportRows: () => process.stdout.rows || 24,
		};
		const { renderCall, renderResult } = createSubagentRenderers(renderDeps);

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate to specialized agents. single: {agent,task} | parallel: {tasks:[]} | chain: {chain:[]} with {previous} placeholder. agentScope: 'both' (default) uses project .draht/agents/ + global. " +
				"Agents without a model inherit the current model and thinking level. Optional per-task label/model/thinking.",
			parameters: Params,

			renderCall,
			renderResult,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const scope: AgentScope = (params.agentScope as string as AgentScope) ?? "both";
				noteProjectTrust(ctx);
				const agents = discoverAgents(ctx.cwd, scope, ctx.isProjectTrusted());
				const available = agents.map((a) => a.name).join(", ") || "none";

				const find = (name: string) => agents.find((a) => a.name === name);
				const notFound = (name: string) => ({
					content: [{ type: "text" as const, text: `Unknown agent "${name}". Available: ${available}` }],
					isError: true,
					details: {} as EmptyDetails,
				});

				const worktree = Boolean(params.worktree);

				// `getPolyphaseSession` keys a `WeakMap` on this value, which throws a `TypeError` for
				// anything that is not an object. Not reachable through a real session (`sessionManager`
				// is always set there), but the fake `pi`/`ctx` used by the trust test suite omits it.
				if (typeof ctx.sessionManager !== "object" || ctx.sessionManager === null) {
					return {
						content: [{ type: "text" as const, text: "No session available for subagent delegation." }],
						isError: true,
						details: {} as EmptyDetails,
					};
				}

				const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
				currentSession = session;
				const settings = session.settings();

				const depth = currentPolyphaseDepth();
				if (depth >= settings.maxDepth) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Delegation depth limit reached (depth ${depth}, polyphase.maxDepth ${settings.maxDepth}).`,
							},
						],
						isError: true,
						details: {} as EmptyDetails,
					};
				}

				const available_ = ctx.modelRegistry.getAvailable();
				const exclude = depth + 1 >= settings.maxDepth ? ["subagent"] : [];

				// ── Chain mode ──
				if (params.chain?.length) {
					const steps: Array<{ agent: AgentConfig; task: string; model?: string; thinking?: string }> = [];
					for (const step of params.chain) {
						const agent = find(step.agent);
						if (!agent) return notFound(step.agent);
						steps.push({ agent, task: step.task, model: step.model, thinking: step.thinking });
					}

					const labels = assignLabels(params.chain.map((s, i) => ({ agent: steps[i].agent, label: s.label })));
					const choices: ReturnType<typeof resolveChildModel>[] = [];
					for (let i = 0; i < steps.length; i++) {
						const step = steps[i];
						try {
							choices.push(
								resolveChildModel({
									override: step.model,
									effort: step.thinking,
									agentModel: step.agent.model,
									parentModel: ctx.model,
									parentThinking: ctx.thinkingLevel,
									available: available_,
								}),
							);
						} catch (error) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Invalid model for chain step ${i + 1} (${step.agent.name}): ${error instanceof Error ? error.message : String(error)}`,
									},
								],
								isError: true,
								details: {} as EmptyDetails,
							};
						}
					}

					const title = `subagent chain · ${steps.map((s) => s.agent.name).join(" → ")}`;
					const run = session.store.createRun({
						id: toolCallId,
						kind: "subagent",
						origin: "tool",
						mode: "chain",
						title,
						budgetTokens: null,
						parentSignal: signal,
					});
					// Chain steps relay `{previous}` through their own per-chain mailbox (runChainTasks /
					// `chainMailbox` above), not through a run mailbox like parallel/single mode: there is no
					// `resultMailbox` field on `RunChainTasksOptions`, so one is never created here.
					let emitter: ReturnType<typeof createPartialUpdateEmitter> | undefined;
					try {
						const live = steps.map((step, i) =>
							run.addAgent({
								label: labels[i],
								agentType: step.agent.name,
								task: step.task,
								step: i + 1,
								model: choices[i].info,
							}),
						);
						emitter = createPartialUpdateEmitter(run, onUpdate, {
							mode: ctx.mode,
							liveUpdateMs: settings.liveUpdateMs,
						});

						const perItem = (i: number) => ({
							signal: live[i].signal,
							run: live[i].createRunContext({
								model: choices[i].modelArg,
								thinking: choices[i].thinking,
								modelInfo: choices[i].info,
								fallbackToChildDefaultModel: choices[i].info.source === "inherited",
								excludeTools: exclude,
							}),
						});

						const results = await runChainTasks(
							ctx.cwd,
							steps.map((s) => ({ agent: s.agent, task: s.task })),
							{ signal, worktree, runner: runnerOverride, limiter: session.limiter, perItem },
						);

						const last = results[results.length - 1];
						const mergeNotices = results
							.map(describeMergeFailure)
							.filter((notice): notice is string => notice !== undefined);
						const isError = last.exitCode !== 0 || mergeNotices.length > 0;
						const status =
							last.exitCode !== 0 ? (last.cancelled ? "cancelled" : "failed") : isError ? "failed" : "done";
						run.finish(status);

						const content = formatSubagentResultText(run, {
							mode: "chain",
							resultChars: settings.resultChars,
							notices: mergeNotices,
						});

						return {
							content: [{ type: "text" as const, text: content }],
							...(isError ? { isError: true } : {}),
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} catch (error) {
						if (run.status === "running")
							run.finish("failed", error instanceof Error ? error.message : String(error));
						return {
							content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
							isError: true,
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} finally {
						emitter?.dispose();
					}
				}

				// ── Parallel mode ──
				if (params.tasks?.length) {
					if (params.tasks.length > MAX_PARALLEL) {
						return {
							content: [{ type: "text" as const, text: `Too many tasks (max ${MAX_PARALLEL})` }],
							isError: true,
							details: {} as EmptyDetails,
						};
					}
					const items: Array<{ agent: AgentConfig; task: string; model?: string; thinking?: string }> = [];
					for (const t of params.tasks) {
						const agent = find(t.agent);
						if (!agent) return notFound(t.agent);
						items.push({ agent, task: t.task, model: t.model, thinking: t.thinking });
					}

					const labels = assignLabels(params.tasks.map((t, i) => ({ agent: items[i].agent, label: t.label })));
					const choices: ReturnType<typeof resolveChildModel>[] = [];
					for (let i = 0; i < items.length; i++) {
						const item = items[i];
						try {
							choices.push(
								resolveChildModel({
									override: item.model,
									effort: item.thinking,
									agentModel: item.agent.model,
									parentModel: ctx.model,
									parentThinking: ctx.thinkingLevel,
									available: available_,
								}),
							);
						} catch (error) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Invalid model for task ${i + 1} (${item.agent.name}): ${error instanceof Error ? error.message : String(error)}`,
									},
								],
								isError: true,
								details: {} as EmptyDetails,
							};
						}
					}

					const title = `subagent parallel · ${items.length} agents`;
					const run = session.store.createRun({
						id: toolCallId,
						kind: "subagent",
						origin: "tool",
						mode: "parallel",
						title,
						budgetTokens: null,
						parentSignal: signal,
					});
					let mailbox: ReturnType<typeof createRunMailbox> | undefined;
					let emitter: ReturnType<typeof createPartialUpdateEmitter> | undefined;
					try {
						const live = items.map((item, i) =>
							run.addAgent({
								label: labels[i],
								agentType: item.agent.name,
								task: item.task,
								model: choices[i].info,
							}),
						);
						mailbox = createRunMailbox("subagent-run");
						emitter = createPartialUpdateEmitter(run, onUpdate, {
							mode: ctx.mode,
							liveUpdateMs: settings.liveUpdateMs,
						});

						const perItem = (i: number) => ({
							signal: live[i].signal,
							run: live[i].createRunContext({
								model: choices[i].modelArg,
								thinking: choices[i].thinking,
								modelInfo: choices[i].info,
								fallbackToChildDefaultModel: choices[i].info.source === "inherited",
								excludeTools: exclude,
							}),
						});

						const results = await runParallelTasks(
							ctx.cwd,
							items.map((item) => ({ agent: item.agent, task: item.task })),
							{
								signal,
								worktree,
								runner: runnerOverride,
								limiter: session.limiter,
								resultMailbox: mailbox.name,
								perItem,
							},
						);

						const succeeded = results.some((r) => r.exitCode === 0 && describeMergeFailure(r) === undefined);
						const allCancelled = results.every((r) => r.cancelled);
						const status = succeeded ? "done" : allCancelled ? "cancelled" : "failed";
						run.finish(status);

						const mergeNotices = results
							.map(describeMergeFailure)
							.filter((notice): notice is string => notice !== undefined);
						const content = formatSubagentResultText(run, {
							mode: "parallel",
							resultChars: settings.resultChars,
							notices: mergeNotices,
						});

						return {
							content: [{ type: "text" as const, text: content }],
							...(succeeded ? {} : { isError: true }),
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} catch (error) {
						if (run.status === "running")
							run.finish("failed", error instanceof Error ? error.message : String(error));
						return {
							content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
							isError: true,
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} finally {
						emitter?.dispose();
						mailbox?.dispose();
					}
				}

				// ── Single mode ──
				if (params.agent && params.task) {
					const agent = find(params.agent);
					if (!agent) return notFound(params.agent);

					let choice: ReturnType<typeof resolveChildModel>;
					try {
						choice = resolveChildModel({
							override: params.model,
							effort: params.thinking,
							agentModel: agent.model,
							parentModel: ctx.model,
							parentThinking: ctx.thinkingLevel,
							available: available_,
						});
					} catch (error) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Invalid model for ${params.agent}: ${error instanceof Error ? error.message : String(error)}`,
								},
							],
							isError: true,
							details: {} as EmptyDetails,
						};
					}

					const title = `subagent ${agent.name}`;
					const run = session.store.createRun({
						id: toolCallId,
						kind: "subagent",
						origin: "tool",
						mode: "single",
						title,
						budgetTokens: null,
						parentSignal: signal,
					});
					let mailbox: ReturnType<typeof createRunMailbox> | undefined;
					let emitter: ReturnType<typeof createPartialUpdateEmitter> | undefined;
					try {
						const label = labelKey({ agent, label: params.label });
						const live = run.addAgent({ label, agentType: agent.name, task: params.task, model: choice.info });
						mailbox = createRunMailbox("subagent-run");
						emitter = createPartialUpdateEmitter(run, onUpdate, {
							mode: ctx.mode,
							liveUpdateMs: settings.liveUpdateMs,
						});

						const runContext = live.createRunContext({
							model: choice.modelArg,
							thinking: choice.thinking,
							modelInfo: choice.info,
							fallbackToChildDefaultModel: choice.info.source === "inherited",
							excludeTools: exclude,
						});

						const result = await runSingleTask(ctx.cwd, agent, params.task, {
							signal: live.signal,
							worktree,
							runner: runnerOverride,
							resultMailbox: mailbox.name,
							limiter: session.limiter,
							run: runContext,
						});

						const mergeNotice = describeMergeFailure(result);
						// Matches chain/parallel: a worktree merge-back failure fails the run even when the
						// child itself exited 0, instead of reporting "done" with `isError` as the only signal.
						const status =
							result.exitCode !== 0
								? result.cancelled
									? "cancelled"
									: "failed"
								: mergeNotice !== undefined
									? "failed"
									: "done";
						run.finish(status);

						const content = formatSubagentResultText(run, {
							mode: "single",
							resultChars: settings.resultChars,
							notices: mergeNotice !== undefined ? [mergeNotice] : [],
						});
						const isError = result.exitCode !== 0 || mergeNotice !== undefined;

						return {
							content: [{ type: "text" as const, text: content }],
							...(isError ? { isError: true } : {}),
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} catch (error) {
						if (run.status === "running")
							run.finish("failed", error instanceof Error ? error.message : String(error));
						return {
							content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
							isError: true,
							details: buildDetails(run, { final: true }),
							usage: sumRunUsage(run),
						};
					} finally {
						emitter?.dispose();
						mailbox?.dispose();
					}
				}

				return {
					content: [{ type: "text" as const, text: `Provide exactly one mode. Available agents: ${available}` }],
					isError: true,
					details: {} as EmptyDetails,
				};
			},
		});

		// ── Permission gate hook point ────────────────────────────────────────────
		// Prepares the wiring point for the multi-agent permission gate: every tool
		// call in this process is offered to the gate before it runs. Rules are
		// (re)loaded per call so project-local `.draht/permissions.yml` edits — read
		// only for a trusted project — and per-session cwd changes take effect
		// without an extension reload.
		//
		// The session permission mode (default/auto/yolo) is session-scoped state,
		// settable via /permissions and /yolo below and seeded from
		// DRAHT_PERMISSION_MODE. It relaxes prompting, never `deny` rules.
		let permissionMode: PermissionMode = isPermissionMode(process.env.DRAHT_PERMISSION_MODE)
			? process.env.DRAHT_PERMISSION_MODE
			: "default";

		function updatePermissionStatus(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) {
			ctx.ui.setStatus("permissions", permissionMode === "default" ? undefined : `perms: ${permissionMode}`);
		}

		const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
			default: "rules as authored; unmatched bash commands require approval",
			auto: "auto-approve bash unless the command looks dangerous (deny rules still block)",
			yolo: "no approval prompts this session (deny rules still block)",
		};

		pi.on("tool_call", (event, ctx) => {
			noteProjectTrust(ctx);
			return createPermissionGateToolCallHandler(
				new PermissionGate(loadPermissionRules(ctx.cwd, ctx.isProjectTrusted()), {
					cwd: ctx.cwd,
					mode: permissionMode,
				}),
				{
					describe: (e, c) => {
						if (e.toolName !== WORKFLOW_TOOL_NAME) return undefined;
						try {
							const limits = resolvePolyphaseSettings(pi.getSettings().polyphase);
							return describeToolCallForApproval(e.toolName, (e.input ?? {}) as Record<string, unknown>, {
								cwd: c.cwd,
								projectTrusted: c.isProjectTrusted(),
								agentDir: getAgentDir(),
								limits: {
									concurrency: limits.maxConcurrency,
									maxAgents: limits.maxAgentsPerRun,
									budgetTokens: limits.defaultBudgetTokens,
								},
							});
						} catch {
							return undefined;
						}
					},
					beforePrompt: (c) => peekPolyphaseSession(c.sessionManager)?.notifyParentPrompt(),
				},
			)(event, ctx);
		});

		// /permissions command — show or set the session permission mode
		pi.registerCommand("permissions", {
			description: `Show or set the session permission mode. Usage: /permissions [${PERMISSION_MODES.join("|")}]`,
			handler: async (args, ctx) => {
				const requested = args.trim();
				if (!requested) {
					ctx.ui.notify(`Permission mode: ${permissionMode} — ${MODE_DESCRIPTIONS[permissionMode]}`, "info");
					return;
				}
				if (!isPermissionMode(requested)) {
					ctx.ui.notify(`Unknown mode "${requested}". Available: ${PERMISSION_MODES.join(", ")}`, "warning");
					return;
				}
				permissionMode = requested;
				updatePermissionStatus(ctx);
				ctx.ui.notify(`Permission mode: ${permissionMode} — ${MODE_DESCRIPTIONS[permissionMode]}`, "info");
			},
		});

		// /yolo command — toggle yolo mode for this session
		pi.registerCommand("yolo", {
			description: "Toggle yolo permission mode for this session (skip approval prompts; deny rules still block)",
			handler: async (_args, ctx) => {
				permissionMode = permissionMode === "yolo" ? "default" : "yolo";
				updatePermissionStatus(ctx);
				ctx.ui.notify(
					permissionMode === "yolo"
						? "yolo mode ON — no approval prompts this session (deny rules still block)"
						: "yolo mode OFF — back to default permissions",
					"info",
				);
			},
		});

		// ── Agent selection for user prompts ─────────────────────────────────────

		let selectedAgent: string | undefined;

		function updateAgentStatus(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) {
			ctx.ui.setStatus("agent", selectedAgent ? `agent: ${selectedAgent}` : undefined);
		}

		// /agent command — select an agent or clear selection
		pi.registerCommand("agent", {
			description: "Select an agent to handle your next prompts, or clear selection. Usage: /agent [name]",
			handler: async (args, ctx) => {
				noteProjectTrust(ctx);
				const agents = discoverAgents(ctx.cwd, "both", ctx.isProjectTrusted());

				if (args.trim()) {
					// Direct selection: /agent architect
					const name = args.trim();
					if (name === "none" || name === "off" || name === "clear") {
						selectedAgent = undefined;
						updateAgentStatus(ctx);
						ctx.ui.notify("Agent cleared — prompts go to default model", "info");
						return;
					}
					const agent = agents.find((a) => a.name === name);
					if (!agent) {
						const available = agents.map((a) => a.name).join(", ") || "none";
						ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "warning");
						return;
					}
					selectedAgent = name;
					updateAgentStatus(ctx);
					ctx.ui.notify(`Agent set to "${name}" — your prompts will be handled by this agent`, "info");
					return;
				}

				// Interactive selection
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /agent <name> or /agent none", "warning");
					return;
				}

				const optionsList = ["(none — default model)", ...agents.map((a) => `${a.name} — ${a.description}`)];
				const choice = await ctx.ui.select("Select agent for your prompts", optionsList);
				if (choice === undefined) return; // cancelled

				if (choice === optionsList[0]) {
					selectedAgent = undefined;
					updateAgentStatus(ctx);
					ctx.ui.notify("Agent cleared", "info");
				} else {
					const name = choice.split(" — ")[0];
					selectedAgent = name;
					updateAgentStatus(ctx);
					ctx.ui.notify(`Agent set to "${name}"`, "info");
				}
			},
			getArgumentCompletions: (partial) => {
				const cwd = process.cwd();
				const agents = discoverAgents(cwd, "both", rememberedProjectTrust(cwd));
				const names = ["none", ...agents.map((a) => a.name)];
				return names.filter((n) => n.startsWith(partial)).map((n) => ({ value: n, label: n }));
			},
		});

		// Intercept user input when an agent is selected
		pi.on("input", (event, ctx) => {
			noteProjectTrust(ctx);
			if (!selectedAgent) return { action: "continue" as const };
			// Don't intercept slash commands
			if (event.text.startsWith("/") || event.text.startsWith("!")) return { action: "continue" as const };

			const wrapped = `Use the subagent tool to delegate to the "${selectedAgent}" agent with this task:\n\n"${event.text}"\n\nSet agentScope to "both".`;
			return { action: "transform" as const, text: wrapped, images: event.images };
		});

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.sessionManager) return;
			currentSession = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
			currentSession.setPermissionModeProvider(() => permissionMode);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			disposePolyphaseSession(ctx.sessionManager, "shutdown");
			currentSession = undefined;
		});
	};
}

export default createSubagentExtension();
