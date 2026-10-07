/**
 * Starts one workflow run (§14.2): creates the store run and mailbox synchronously, then runs the
 * script asynchronously via the lazily-loaded runtime. `done` never rejects.
 */

import type { Usage } from "@draht/ai";
import { createRunMailbox } from "../../builtins/subagent.ts";
import type { ExtensionContext } from "../../extensions/types.ts";
import { buildDetails, sumRunUsage } from "../details.ts";
import { formatWorkflowResultText, type WorkflowOutcomeSummary } from "../result-text.ts";
import type { PolyphaseSession } from "../session.ts";
import type { PolyphaseRun } from "../store.ts";
import type { AgentRunner, PolyphaseDetails, RunOrigin, WorkflowSource } from "../types.ts";
import { createWorkflowAgentHost } from "./agent-host.ts";
import type { WorkflowMeta } from "./meta.ts";
import { loadWorkflowRuntime } from "./runtime.lazy.ts";
import type { WorkflowOutcome, WorkflowScriptError } from "./runtime.ts";

export interface StartWorkflowRunOptions {
	ctx: ExtensionContext;
	session: PolyphaseSession;
	id: string;
	origin: RunOrigin;
	parentSignal?: AbortSignal;
	meta: WorkflowMeta;
	body: string;
	args: string;
	source: { kind: WorkflowSource; path?: string };
	budgetTokens: number | null;
	runner?: AgentRunner;
}

export interface WorkflowRunCompletion {
	outcome: WorkflowOutcome;
	text: string;
	details: PolyphaseDetails;
	usage: Usage | undefined;
	isError: boolean;
}

export interface WorkflowRunHandle {
	readonly run: PolyphaseRun;
	/** Never rejects. */
	readonly done: Promise<WorkflowRunCompletion>;
}

const RESULT_PREVIEW_MAX_CHARS = 400;

/** A one-line JSON preview of the value (DESIGN.md §14.2 step 4): `JSON.stringify` even for a
 * string value, so embedded newlines are escaped instead of breaking the row onto several lines.
 * `undefined` (no return value) has no preview at all. */
function resultPreviewOf(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	// Measured and truncated by code point, not UTF-16 code unit, throughout: comparing `text.length`
	// (code units) against the cap but truncating by code point let a text over the unit cap but at
	// or under the code-point cap (e.g. ~300 non-BMP emoji) through untruncated, with a trailing "…"
	// that still marked it as truncated, and let the truncated preview reach ~2x the intended cap.
	const codePoints = Array.from(text);
	if (codePoints.length <= RESULT_PREVIEW_MAX_CHARS) return text;
	return `${codePoints.slice(0, RESULT_PREVIEW_MAX_CHARS - 1).join("")}…`;
}

/** Folds the sandbox's redeclaration hint (runtime.ts) into the message so it survives into
 * `WorkflowOutcomeSummary`, which has no `hint` field of its own. */
function errorMessageWithHint(error: WorkflowScriptError): string {
	return error.hint ? `${error.message} (hint: ${error.hint})` : error.message;
}

function toSummary(outcome: WorkflowOutcome): WorkflowOutcomeSummary {
	if (outcome.ok) return { ok: true, value: outcome.value, consoleOutput: outcome.consoleOutput };
	return {
		ok: false,
		errorKind: outcome.error.kind,
		errorMessage: errorMessageWithHint(outcome.error),
		errorLine: outcome.error.line,
		consoleOutput: outcome.consoleOutput,
	};
}

function finishRun(run: PolyphaseRun, outcome: WorkflowOutcome): WorkflowRunCompletion {
	if (outcome.ok) {
		const preview = resultPreviewOf(outcome.value);
		if (preview !== undefined) run.setResultPreview(preview);
		run.finish("done");
	} else if (outcome.error.kind === "aborted") {
		run.finish("cancelled", outcome.error.message);
	} else {
		const composed = errorMessageWithHint(outcome.error);
		const message = outcome.error.line !== undefined ? `line ${outcome.error.line}: ${composed}` : composed;
		run.finish("failed", message);
	}

	const summary = toSummary(outcome);
	return {
		outcome,
		text: formatWorkflowResultText(run, summary),
		details: buildDetails(run, { final: true }),
		usage: sumRunUsage(run),
		isError: !outcome.ok,
	};
}

function failedCompletion(run: PolyphaseRun, message: string): WorkflowRunCompletion {
	run.finish("failed", message);
	const outcome: WorkflowOutcome = {
		ok: false,
		error: { kind: "sandbox", message },
		consoleOutput: [],
		agentCalls: 0,
	};
	return {
		outcome,
		text: formatWorkflowResultText(run, toSummary(outcome)),
		details: buildDetails(run, { final: true }),
		usage: sumRunUsage(run),
		isError: true,
	};
}

/** Built without `buildDetails`/`formatWorkflowResultText` so it can never itself throw; used only
 * when `failedCompletion` (which calls those) throws a second time (DESIGN.md §14.2 step 4: `done`
 * must never reject). */
function minimalFailedCompletion(run: PolyphaseRun, meta: WorkflowMeta, message: string): WorkflowRunCompletion {
	run.finish("failed", message);
	const outcome: WorkflowOutcome = {
		ok: false,
		error: { kind: "sandbox", message },
		consoleOutput: [],
		agentCalls: 0,
	};
	const details: PolyphaseDetails = {
		v: 1,
		runId: run.id,
		kind: run.kind,
		origin: run.origin,
		title: run.title,
		status: "failed",
		startedAt: run.startedAt,
		endedAt: run.endedAt ?? Date.now(),
		agents: [],
		totals: { agents: 0, tokens: 0, cost: 0, byStatus: {}, blockedToolCalls: 0 },
		error: message,
	};
	return {
		outcome,
		text: `Workflow ${meta.name} failed: ${message}`,
		details,
		usage: undefined,
		isError: true,
	};
}

export function startWorkflowRun(options: StartWorkflowRunOptions): WorkflowRunHandle {
	const { ctx, session, id, origin, parentSignal, meta, body, args, source, budgetTokens, runner } = options;
	const settings = session.settings();

	const run = session.store.createRun({
		id,
		kind: "workflow",
		origin,
		title: meta.name,
		workflow: { name: meta.name, description: meta.description, source: source.kind, path: source.path, args },
		phases: meta.phases,
		budgetTokens,
		parentSignal,
	});

	const mailbox = createRunMailbox("workflow-run");

	const done = (async (): Promise<WorkflowRunCompletion> => {
		let host: ReturnType<typeof createWorkflowAgentHost> | undefined;
		try {
			const runtime = await loadWorkflowRuntime();
			host = createWorkflowAgentHost({ ctx, session, run, meta, mailbox: mailbox.name, runner });
			const outcome = await runtime.runWorkflowScript({
				meta,
				body,
				args,
				budgetTokens,
				maxAgents: settings.maxAgentsPerRun,
				maxItemsPerCall: settings.maxItemsPerCall,
				timeoutMs: settings.workflowTimeoutMs,
				signal: run.signal,
				host,
			});
			// The sandbox may finish (abort, timeout, script error, script return) while an agent it
			// abandoned mid-call is still being torn down (DESIGN.md §14.2 step 4); wait for every
			// `runSingleTask` this host started before snapshotting the run as final.
			await host.settled();
			return finishRun(run, outcome);
		} catch (error) {
			// Defensive: `runWorkflowScript` never rejects while agents are in flight today
			// (`finish()` aborts every pending host call), but if it ever did, awaiting `settled()`
			// without cancelling first would let paid children run to completion unobserved.
			run.cancel("run");
			await host?.settled();
			const message = error instanceof Error ? error.message : String(error);
			try {
				return failedCompletion(run, message);
			} catch {
				// formatWorkflowResultText/buildDetails/sumRunUsage threw a second time; fall back to a
				// completion that can't itself throw, so `done` still never rejects.
				return minimalFailedCompletion(run, meta, message);
			}
		} finally {
			mailbox.dispose();
		}
	})();

	return { run, done };
}
