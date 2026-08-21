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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@draht/ai";
import { Text } from "@draht/tui";
import { Type } from "@sinclair/typebox";
import { getAgentDir, getPackageDir, isBunBinary } from "../../config.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { canonicalizePath } from "../../utils/paths.js";
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
	type MergeResult,
	PERMISSION_MODES,
	PermissionGate,
	type PermissionMode,
	TaskBoard,
	WorktreeIsolator,
} from "../multi-agent/index.ts";
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

// Build the command to spawn a subagent process.
// Compiled Bun binary: process.execPath IS the CLI binary, args go directly.
// Source/dev mode: process.execPath is the runtime (bun/node), process.argv[1] is the CLI script.
const DRAHT_BIN = process.execPath;
const DRAHT_ARGS_PREFIX: string[] = isBunBinary ? [] : [process.argv[1]];

// ─── Agent discovery ────────────────────────────────────────────────────────

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Disable user and project extensions in the child process. Core builtins still load. */
	disableExtensions?: boolean;
	systemPrompt: string;
	source: "user" | "project";
}

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
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".draht", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

type AgentScope = "user" | "project" | "both";

function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	// Shipped agents (bundled with the package) — lowest priority
	const shippedDir = path.join(getPackageDir(), "agents");
	const shippedAgents = loadAgentsFromDir(shippedDir, "user");

	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);
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

export interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage?: Usage;
	step?: number;
	/**
	 * Outcome of merging the task's worktree branch back. Present only when
	 * the run opted into worktree isolation, a real worktree existed (git
	 * repo), and the agent exited 0 so a merge-back was attempted.
	 */
	merge?: MergeResult;
}

function writeTemp(name: string, content: string): { file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-subagent-"));
	const file = path.join(dir, `${name.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	return { file, dir };
}

function cleanTemp(file: string, dir: string) {
	try {
		fs.unlinkSync(file);
	} catch {}
	try {
		fs.rmdirSync(dir);
	} catch {}
}

function getFinalAssistant(messages: Message[]): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function getFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getCombinedUsage(messages: Message[]): Usage | undefined {
	const usages = messages
		.filter((message) => message.role === "assistant")
		.map((message) => message.usage)
		.filter((usage) => usage !== undefined);
	if (usages.length === 0) return undefined;
	return usages.reduce((total, usage) => ({
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		...(total.cacheWrite1h !== undefined || usage.cacheWrite1h !== undefined
			? { cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }
			: {}),
		...(total.reasoning !== undefined || usage.reasoning !== undefined
			? { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) }
			: {}),
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: {
			input: total.cost.input + usage.cost.input,
			output: total.cost.output + usage.cost.output,
			cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
			total: total.cost.total + usage.cost.total,
		},
	}));
}

type ProgressFn = (activity: string) => void;

async function runAgent(
	cwd: string,
	agent: AgentConfig,
	task: string,
	signal?: AbortSignal,
	step?: number,
	onProgress?: ProgressFn,
): Promise<RunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	if (agent.disableExtensions) args.push("--no-extensions");

	let tmpFile: string | null = null;
	let tmpDir: string | null = null;

	if (agent.systemPrompt.trim()) {
		const tmp = writeTemp(agent.name, agent.systemPrompt);
		tmpFile = tmp.file;
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmpFile);
	}

	const messages: Message[] = [];
	let stderr = "";

	try {
		const processExitCode = await new Promise<number>((resolve) => {
			let closed = false;
			const proc = spawn(DRAHT_BIN, [...DRAHT_ARGS_PREFIX, ...args], {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			proc.stdin.on("error", () => {});
			proc.stdin.end(`Task: ${task}`);
			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
						messages.push(event.message as Message);
					}
					// Stream activity updates to the parent
					if (onProgress) {
						if (event.type === "tool_execution_start") {
							const toolArgs = event.args ?? {};
							const detail = toolArgs.command || toolArgs.path || toolArgs.file_path || toolArgs.pattern || "";
							const short =
								typeof detail === "string" && detail.length > 60 ? `${detail.slice(0, 60)}...` : detail;
							onProgress(short ? `${event.toolName} ${short}` : event.toolName);
						} else if (event.type === "text_delta") {
							// Show first line of streaming text as activity
							const text = event.text?.trim();
							if (text) {
								const firstLine = text.split("\n")[0];
								const short = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
								onProgress(short);
							}
						}
					}
				} catch {}
			};

			proc.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const l of lines) processLine(l);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			proc.on("close", (code) => {
				closed = true;
				if (buf.trim()) processLine(buf);
				resolve(code ?? 1);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!closed) proc.kill("SIGKILL");
					}, 5000).unref();
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		const finalAssistant = getFinalAssistant(messages);
		const failedResponse = finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted";
		return {
			agent: agent.name,
			task,
			exitCode: processExitCode === 0 && !failedResponse ? 0 : 1,
			output: getFinalText(messages),
			stderr: stderr || (failedResponse ? (finalAssistant.errorMessage ?? finalAssistant.stopReason) : ""),
			usage: getCombinedUsage(messages),
			step,
		};
	} finally {
		if (tmpFile && tmpDir) cleanTemp(tmpFile, tmpDir);
	}
}

async function runParallel<T>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<T extends unknown ? RunResult : never>,
): Promise<RunResult[]> {
	const results: RunResult[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await (fn as (item: T, i: number) => Promise<RunResult>)(items[i], i);
			}
		}),
	);
	return results;
}

// ─── Multi-agent orchestration ─────────────────────────────────────────────
//
// Wraps `runAgent` (the raw spawn-a-subprocess primitive above) with the
// multi-agent coordination primitives: an AgentFSM tracks each run's
// IDLE→REQUEST→WORKING→RESPOND→IDLE lifecycle, a mailbox delivers the run's
// TaskResult (or Abort on failure) to an interested recipient, and worktree
// isolation is applied opt-in per run. Parallel mode additionally posts each
// task to the shared TaskBoard so agents "self-assign" work; chain mode
// relays `{previous}` between steps via a per-chain mailbox instead of a bare
// local variable.

/** Pluggable process runner, so orchestration can be exercised without spawning a real subprocess. */
export type AgentRunner = (
	cwd: string,
	agent: AgentConfig,
	task: string,
	signal?: AbortSignal,
	step?: number,
	onProgress?: ProgressFn,
) => Promise<RunResult>;

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
	/** Process runner to use. Defaults to the real spawn-based `runAgent`. */
	runner?: AgentRunner;
}

/**
 * Runs one agent task through the full multi-agent lifecycle: FSM
 * transitions around the run, opt-in worktree isolation, and a mailbox
 * message on completion. This is the single point every orchestration mode
 * (single/parallel/chain) below funnels through.
 */
async function runAgentWithLifecycle(
	cwd: string,
	agent: AgentConfig,
	task: string,
	opts: LifecycleOptions,
): Promise<RunResult> {
	const { agentId, resultMailbox = SUBAGENT_RESULT_MAILBOX, worktree, taskId = agentId, runner = runAgent } = opts;

	const fsm = new AgentFSM(agentId);
	const forward = (event: AgentFSMTransitionEvent) => {
		for (const listener of fsmTransitionListeners) listener(event);
	};
	fsm.onTransition(forward);
	mailboxSystem.register(agentId);

	fsm.transition("REQUEST");
	fsm.transition("WORKING");

	const effectiveCwd = worktree ? worktreeIsolator.create(cwd, taskId) : cwd;

	const result = await runner(effectiveCwd, agent, task, opts.signal, opts.step, opts.onProgress);

	// effectiveCwd === cwd means create() fell back to cwd outside a git repo,
	// where merge(taskId) would fabricate a failure for the unknown taskId.
	if (worktree && effectiveCwd !== cwd) {
		if (result.exitCode === 0) result.merge = worktreeIsolator.merge(taskId);
		worktreeIsolator.cleanup(taskId);
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

	return result;
}

export interface RunSingleTaskOptions {
	signal?: AbortSignal;
	onProgress?: ProgressFn;
	worktree?: boolean;
	runner?: AgentRunner;
	agentId?: string;
	resultMailbox?: string;
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
}

/**
 * Parallel-mode orchestration: every task is posted to the shared TaskBoard
 * up front (with `{ agentType: agent.name }` requirements), then atomically
 * assigned to its corresponding worker. Direct assignment keeps concurrent
 * orchestration calls from claiming one another's same-role tasks.
 */
export async function runParallelTasks(
	cwd: string,
	items: Array<{ agent: AgentConfig; task: string }>,
	opts: RunParallelTasksOptions = {},
): Promise<RunResult[]> {
	const postedIds = items.map((item) =>
		taskBoard.post({ requirements: { agentType: item.agent.name }, description: item.task }),
	);

	return runParallel(items, MAX_CONCURRENCY, async (item, i) => {
		const workerId = `parallel-${i}-${randomUUID()}`;
		const taskId = postedIds[i];
		const assignment = taskBoard.assign(taskId, workerId);
		if (!assignment.ok) throw new Error(assignment.error);

		const result = await runAgentWithLifecycle(cwd, item.agent, item.task, {
			signal: opts.signal,
			onProgress: opts.makeOnProgress?.(item.agent.name),
			worktree: opts.worktree,
			runner: opts.runner,
			resultMailbox: opts.resultMailbox,
			agentId: workerId,
			taskId,
		});

		if (result.exitCode === 0) taskBoard.complete(taskId, result.output);
		else taskBoard.fail(taskId, result.stderr || result.output || "subagent task failed");

		return result;
	});
}

export interface RunChainTasksOptions {
	signal?: AbortSignal;
	makeOnProgress?: (agentName: string) => ProgressFn;
	worktree?: boolean;
	runner?: AgentRunner;
	/** Called before each step starts, e.g. to report "step i/total" progress. */
	onBeforeStep?: (index: number, total: number, agentName: string) => void;
}

/**
 * Chain-mode orchestration: steps run sequentially, each with its own FSM.
 * `{previous}` is resolved from a per-chain relay mailbox that each step's
 * TaskResult is delivered to — not a bare local variable — so downstream
 * steps consume the prior step's output the same way any other mailbox
 * message-passing consumer would. Stops (without throwing) at the first
 * failed step; the failed result is still included as the last entry.
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
			const task = step.task.replace(/\{previous\}/g, previous);

			const result = await runAgentWithLifecycle(cwd, step.agent, task, {
				signal: opts.signal,
				step: i + 1,
				onProgress: opts.makeOnProgress?.(step.agent.name),
				worktree: opts.worktree,
				runner: opts.runner,
				resultMailbox: chainMailbox,
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

/** Grapheme budget for every attacker-influenced string that travels in a permission ask. */
const PERMISSION_DETAIL_MAX_GRAPHEMES = 512;

/**
 * Byte budget for the same strings, stated HERE and not left to the default, because this is the
 * producer whose output has to fit a frame: one grapheme cluster admits unboundedly many combining
 * marks, so 512 clusters of Zalgo weighed 383,246 bytes until this bound existed — accepted by the
 * schema, then refused by the attach bridge, which closed the renderer's socket with 1008.
 *
 * 512 × 4 bytes: four is the widest a single code point is in UTF-8, so every ordinary cluster
 * survives untouched. A `tool_permission` detail carries FIVE such fields — `toolCallId`,
 * `toolName`, `cwd`, `reason`, and exactly one of `command` / `path` / `operation` — so at maximum
 * it is 5 × 2048 = 10,240 bytes of free text plus a fixed option pair and a handful of keys: ~10 KiB
 * against the 64 KiB `maxFrameBytes` a permission frame must fit into, which is never split.
 */
const PERMISSION_DETAIL_MAX_BYTES = 512 * 4;

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

/** Neutralize-and-bound a single wire-bound string — in clusters AND bytes — keeping only the safe value. */
function safeField(raw: string): string {
	return boundedSafeText(raw, PERMISSION_DETAIL_MAX_GRAPHEMES, PERMISSION_DETAIL_MAX_BYTES).value;
}

/**
 * Build the canonical detail for a tool permission ask.
 *
 * Neutralization happens HERE, at construction, not at any protocol layer: three renderers
 * (TUI, `draht --attach`, RPC) inherit this object, and the attach client is a bare `JSON.parse`
 * cast that never passes through a schema. Constructing it safe is what makes all three safe.
 */
function buildPermissionAskDetail(event: ToolCallEvent, ctx: ExtensionContext, reason: string): PermissionAskDetail {
	const input = (event.input ?? {}) as Record<string, unknown>;
	const detail: PermissionAskDetail = {
		kind: "tool_permission",
		toolCallId: safeField(event.toolCallId),
		toolName: safeField(event.toolName),
		// `ctx.cwd` is the raw, un-normalised `config.cwd`; a symlinked worktree would otherwise
		// read as a different project on the answering surface.
		cwd: safeField(canonicalizePath(ctx.cwd)),
		reason: safeField(reason),
		options: TOOL_PERMISSION_OPTIONS,
	};

	const command = typeof input.command === "string" ? input.command : undefined;
	const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
	const plainPath = typeof input.path === "string" ? input.path : undefined;

	if (command !== undefined) {
		detail.command = safeField(command);
	} else if (filePath !== undefined || plainPath !== undefined) {
		detail.path = safeField((filePath ?? plainPath) as string);
	} else {
		// Every extension tool takes `Record<string, unknown>`, so there is always SOMETHING to
		// show. Serializing the whole argument object beats an empty ask that asks the human to
		// approve an unknown action.
		detail.operation = safeField(serializeToolInput(input));
	}

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
				return { block: true, reason: `${decision.reason} (no UI available to request approval)` };
			}

			const detail = buildPermissionAskDetail(event, ctx, decision.reason);
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
			const approved = await ctx.ui.confirm("Approve tool call?", `${event.toolName}: ${decision.reason}`, {
				detail,
				signal: ctx.signal,
			});
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task description" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task, optionally using {previous} placeholder" }),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chained tasks" })),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], { default: "both" }),
	),
	worktree: Type.Optional(
		Type.Boolean({ description: "Opt-in: run each task in an isolated git worktree, merged back on success" }),
	),
});

// ─── Rendering helpers ──────────────────────────────────────────────────────

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

function truncateTask(task: string, maxLen = 120): string {
	const oneLine = task.replace(/\n/g, " ").trim();
	return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate to specialized agents. single: {agent,task} | parallel: {tasks:[]} | chain: {chain:[]} with {previous} placeholder. agentScope: 'both' (default) uses project .draht/agents/ + global.",
		parameters: Params,

		renderCall(args, theme) {
			const lines: string[] = [];

			if (args.chain?.length) {
				const agents = args.chain.map((s: { agent: string }) => s.agent).join(" -> ");
				lines.push(`${theme.fg("toolTitle", theme.bold(`subagent chain`))} ${theme.fg("accent", agents)}`);
				for (let i = 0; i < args.chain.length; i++) {
					const step = args.chain[i];
					const prefix = theme.fg("muted", `  ${i + 1}.`);
					lines.push(
						`${prefix} ${theme.fg("accent", step.agent)} ${theme.fg("toolOutput", truncateTask(step.task))}`,
					);
				}
			} else if (args.tasks?.length) {
				lines.push(
					theme.fg("toolTitle", theme.bold(`subagent parallel`)) +
						theme.fg("muted", ` (${args.tasks.length} tasks)`),
				);
				for (const t of args.tasks) {
					lines.push(`  ${theme.fg("accent", t.agent)} ${theme.fg("toolOutput", truncateTask(t.task))}`);
				}
			} else if (args.agent) {
				lines.push(
					theme.fg("toolTitle", theme.bold("subagent")) +
						" " +
						theme.fg("accent", args.agent) +
						(args.task ? ` ${theme.fg("toolOutput", truncateTask(args.task))}` : ""),
				);
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("subagent")));
			}

			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, options, theme) {
			const status = (result.details as { status?: string } | undefined)?.status;
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c) => ("text" in c ? c.text : ""))
					.join("\n") || "";

			const lines: string[] = [];

			if (status) {
				lines.push(theme.fg("muted", status));
			}

			if (output.trim()) {
				const trimmed = output.trim();
				if (options.expanded || options.isPartial) {
					// When expanded or during execution, show full activity log
					for (const line of trimmed.split("\n")) {
						lines.push(theme.fg("toolOutput", line));
					}
				} else {
					// Collapsed final result — show preview
					const allLines = trimmed.split("\n");
					const previewLines = allLines.slice(0, 8);
					lines.push(theme.fg("toolOutput", previewLines.join("\n")));
					if (allLines.length > 8) {
						lines.push(theme.fg("muted", `... (${allLines.length - 8} more lines)`));
					}
				}
			}

			if (lines.length === 0) return new Text("", 0, 0);
			return new Text(lines.join("\n"), 0, 0);
		},

		async execute(_id, params, signal, onUpdate, ctx) {
			const scope: AgentScope = (params.agentScope as string as AgentScope) ?? "both";
			const agents = discoverAgents(ctx.cwd, scope);
			const available = agents.map((a) => a.name).join(", ") || "none";

			const find = (name: string) => agents.find((a) => a.name === name);
			const notFound = (name: string) => ({
				content: [{ type: "text" as const, text: `Unknown agent "${name}". Available: ${available}` }],
				isError: true,
				details: {},
			});

			// Stream live activity from the subagent process
			const activityLines: string[] = [];
			const emitProgress = (agentName: string, activity?: string) => {
				const status = activity ? `${agentName}: ${activity}` : `${agentName} working...`;
				onUpdate?.({
					content: [{ type: "text" as const, text: activityLines.join("\n") }],
					details: { status },
				});
			};
			const makeProgressFn =
				(agentName: string): ProgressFn =>
				(activity) => {
					// Keep a rolling log of recent activities
					activityLines.push(`${agentName}: ${activity}`);
					if (activityLines.length > 50) activityLines.splice(0, activityLines.length - 50);
					emitProgress(agentName, activity);
				};

			const worktree = Boolean(params.worktree);

			// ── Chain mode ──
			if (params.chain?.length) {
				const steps: Array<{ agent: AgentConfig; task: string }> = [];
				for (const step of params.chain) {
					const agent = find(step.agent);
					if (!agent) return notFound(step.agent);
					steps.push({ agent, task: step.task });
				}

				const results = await runChainTasks(ctx.cwd, steps, {
					signal,
					worktree,
					makeOnProgress: (agentName) => makeProgressFn(agentName),
					onBeforeStep: (i, total, agentName) => {
						activityLines.length = 0;
						emitProgress(agentName, `step ${i + 1}/${total}`);
					},
				});

				const mergeNotices = results
					.map(describeMergeFailure)
					.filter((notice): notice is string => notice !== undefined);
				const noticeBlock = mergeNotices.length > 0 ? `\n\n${mergeNotices.join("\n\n")}` : "";

				const last = results[results.length - 1];
				if (last.exitCode !== 0) {
					const failedIndex = results.length - 1;
					return {
						content: [
							{
								type: "text" as const,
								text: `Chain failed at step ${failedIndex + 1} (${params.chain[failedIndex].agent}):\n${last.output || last.stderr}${noticeBlock}`,
							},
						],
						isError: true,
						details: {},
					};
				}
				return {
					content: [{ type: "text" as const, text: `${last.output || "(no output)"}${noticeBlock}` }],
					// A merge-back failure means a step's work did not land in the
					// caller's tree, even though every step's agent succeeded.
					...(mergeNotices.length > 0 ? { isError: true } : {}),
					details: {},
				};
			}

			// ── Parallel mode ──
			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL) {
					return {
						content: [{ type: "text" as const, text: `Too many tasks (max ${MAX_PARALLEL})` }],
						isError: true,
						details: {},
					};
				}
				const items: Array<{ agent: AgentConfig; task: string }> = [];
				for (const t of params.tasks) {
					const agent = find(t.agent);
					if (!agent) return notFound(t.agent);
					items.push({ agent, task: t.task });
				}

				const agentNames = params.tasks.map((t: { agent: string }) => t.agent).join(", ");
				emitProgress(agentNames);

				const results = await runParallelTasks(ctx.cwd, items, {
					signal,
					worktree,
					makeOnProgress: (agentName) => makeProgressFn(agentName),
				});

				const ok = results.filter((r) => r.exitCode === 0 && describeMergeFailure(r) === undefined).length;
				const summary = results
					.map(
						(r) =>
							`[${r.agent}] ${r.exitCode !== 0 ? "fail" : describeMergeFailure(r) ? "merge-failed" : "ok"} ${r.output.slice(0, 200)}`,
					)
					.join("\n\n");
				const notices = results
					.map(describeMergeFailure)
					.filter((notice): notice is string => notice !== undefined);
				const noticeBlock = notices.length > 0 ? `\n\n${notices.join("\n\n")}` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Parallel: ${ok}/${results.length} succeeded\n\n${summary}${noticeBlock}`,
						},
					],
					details: {},
				};
			}

			// ── Single mode ──
			if (params.agent && params.task) {
				const agent = find(params.agent);
				if (!agent) return notFound(params.agent);
				emitProgress(params.agent);
				const result = await runSingleTask(ctx.cwd, agent, params.task, {
					signal,
					worktree,
					onProgress: makeProgressFn(params.agent),
				});
				const mergeNotice = describeMergeFailure(result);
				// A merge-back failure means the delegated change did NOT land in
				// the caller's tree — a plain success would mislead the orchestrator.
				const isError = result.exitCode !== 0 || mergeNotice !== undefined;
				const baseText = result.output || result.stderr || "(no output)";
				return {
					content: [{ type: "text" as const, text: mergeNotice ? `${baseText}\n\n${mergeNotice}` : baseText }],
					...(isError ? { isError: true } : {}),
					details: {},
				};
			}

			return {
				content: [{ type: "text" as const, text: `Provide exactly one mode. Available agents: ${available}` }],
				isError: true,
				details: {},
			};
		},
	});

	// ── Permission gate hook point ────────────────────────────────────────────
	// Prepares the wiring point for the multi-agent permission gate: every tool
	// call in this process is offered to the gate before it runs. Rules are
	// (re)loaded per call so project-local `.draht/permissions.yml` edits and
	// per-session cwd changes take effect without an extension reload.
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

	pi.on("tool_call", (event, ctx) =>
		createPermissionGateToolCallHandler(
			new PermissionGate(loadRules(ctx.cwd), { cwd: ctx.cwd, mode: permissionMode }),
		)(event, ctx),
	);

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
			const agents = discoverAgents(ctx.cwd, "both");

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

			const options = ["(none — default model)", ...agents.map((a) => `${a.name} — ${a.description}`)];
			const choice = await ctx.ui.select("Select agent for your prompts", options);
			if (choice === undefined) return; // cancelled

			if (choice === options[0]) {
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
			const agents = discoverAgents(process.cwd(), "both");
			const names = ["none", ...agents.map((a) => a.name)];
			return names.filter((n) => n.startsWith(partial)).map((n) => ({ value: n, label: n }));
		},
	});

	// Intercept user input when an agent is selected
	pi.on("input", (event) => {
		if (!selectedAgent) return { action: "continue" as const };
		// Don't intercept slash commands
		if (event.text.startsWith("/") || event.text.startsWith("!")) return { action: "continue" as const };

		const wrapped = `Use the subagent tool to delegate to the "${selectedAgent}" agent with this task:\n\n"${event.text}"\n\nSet agentScope to "both".`;
		return { action: "transform" as const, text: wrapped, images: event.images };
	});
}
