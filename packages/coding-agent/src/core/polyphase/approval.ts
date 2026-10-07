/**
 * Approval descriptions for the `workflow` tool and the `/workflow`, `/<name>` command path.
 * See DESIGN.md §15.1.
 */

import * as os from "node:os";
import * as path from "node:path";
import { realPathStrict } from "../../utils/canonical-path.ts";
import type { WorkflowSource } from "./types.ts";
import { WORKFLOW_TOOL_NAME } from "./types.ts";
import { extractWorkflowMeta, type WorkflowMeta, type WorkflowPhaseMeta } from "./workflow/meta.ts";
import { findSavedWorkflow } from "./workflow/saved.ts";

export interface ApprovalDescription {
	title: string;
	message: string;
	operation: string;
}

export interface ApprovalLimits {
	concurrency: number;
	maxAgents: number;
	budgetTokens: number | null;
}

export interface ApprovalContext {
	cwd: string;
	projectTrusted: boolean;
	agentDir: string;
	limits: ApprovalLimits;
}

export interface WorkflowApprovalInfo {
	source: WorkflowSource;
	/** Display path for "project"/"user" sources, already relative to cwd or home. */
	path?: string;
	scriptLines?: number;
	args?: string;
	budgetTokens?: number | null;
}

const MAX_ARG_CHARS = 120;

function truncateArgs(args: string): string {
	const codePoints = Array.from(args);
	if (codePoints.length <= MAX_ARG_CHARS) return args;
	return `${codePoints.slice(0, MAX_ARG_CHARS - 1).join("")}…`;
}

/**
 * Sanitizes, then JSON-quotes, args so model-controlled text can't break the surrounding dialog.
 * `JSON.stringify` already escapes quotes, backslashes and C0 controls (including newlines and
 * tabs) as visible `\n`/`\t`-style sequences, so only the characters it leaves unescaped — C1
 * controls (U+0080-U+009F, including U+009B, the 8-bit CSI), U+2028/U+2029 and bidi overrides —
 * are replaced with spaces first. Unlike `oneLine`'s full C0 sweep (used for prose that must
 * collapse to one row), this must not touch C0 or args would lose their visible escapes.
 */
function quoteArgs(args: string): string {
	return JSON.stringify(sanitizeArgsForQuoting(truncateArgs(args)));
}

function formatApproxTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}m`;
	if (tokens >= 1_000) {
		const kilos = trimDecimal(tokens / 1_000);
		// toFixed(1) can round up to "1000.0", which would display as "1000k" instead of "1m".
		if (Number(kilos) >= 1000) return `${trimDecimal(tokens / 1_000_000)}m`;
		return `${kilos}k`;
	}
	return `${tokens}`;
}

function trimDecimal(value: number): string {
	return Number(value.toFixed(1)).toString();
}

// C0/C1 controls, the Unicode line/paragraph separators, and the bidi embedding/override/isolate
// controls. None of these are escaped by `JSON.stringify`, and a line separator or bidi override
// can visually relocate or hide text in a terminal even where a literal "\n" can't.
const UNSAFE_INLINE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

function sanitizeInline(value: string): string {
	return value.replace(UNSAFE_INLINE_PATTERN, " ");
}

// Same as UNSAFE_INLINE_PATTERN minus C0 (\u0000-\u001f): JSON.stringify already escapes those
// visibly (e.g. "\n", "\t"), so quoteArgs must leave them for it instead of collapsing them here.
const UNSAFE_QUOTED_PATTERN = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

function sanitizeArgsForQuoting(value: string): string {
	return value.replace(UNSAFE_QUOTED_PATTERN, " ");
}

/**
 * Collapses newlines and other unsafe characters to spaces so model-controlled text (a workflow's
 * `meta.description`, phase titles, phase models) can't inject extra lines into the approval
 * message. `boundDialogText` treats every "\n" in the message as a deliberate row break, so an
 * unsanitized multi-line description could push the trust-relevant Source/Limits lines past its
 * row cap.
 */
function oneLine(value: string): string {
	return sanitizeInline(value).replace(/ {2,}/g, " ").trim();
}

function formatBudgetText(budgetTokens: number | null): string {
	return budgetTokens === null ? "no budget" : `budget ${formatApproxTokens(budgetTokens)} tokens`;
}

function formatLimitsLine(limits: ApprovalLimits, budgetTokens: number | null): string {
	return `Limits: ${limits.concurrency} agents at once · up to ${limits.maxAgents} agents · ${formatBudgetText(budgetTokens)}`;
}

function countScriptLines(script: string): number {
	if (script.length === 0) return 0;
	let newlineCount = 0;
	for (let i = 0; i < script.length; i++) if (script.charCodeAt(i) === 10) newlineCount++;
	return script.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function resolveBudgetTokens(input: Record<string, unknown>, limits: ApprovalLimits): number | null {
	const budget = input.budgetTokens;
	return typeof budget === "number" && Number.isFinite(budget) ? budget : limits.budgetTokens;
}

function formatMessagePhases(phases: readonly WorkflowPhaseMeta[]): string {
	return phases
		.map((phase, index) => `${index + 1} ${oneLine(phase.title)}${phase.model ? ` (${oneLine(phase.model)})` : ""}`)
		.join(" · ");
}

function formatOperationPhases(phases: readonly WorkflowPhaseMeta[]): string {
	return phases.map((phase) => oneLine(phase.title)).join(" → ");
}

function formatSourceText(info: WorkflowApprovalInfo): string {
	if (info.source === "inline") {
		const lines = info.scriptLines ?? 0;
		return `inline script written by the model (${lines} ${lines === 1 ? "line" : "lines"})`;
	}
	return `${info.source} ${info.path ?? ""}`.trim();
}

export function describeWorkflowForApproval(
	meta: WorkflowMeta,
	info: WorkflowApprovalInfo,
	limits: ApprovalLimits,
): ApprovalDescription {
	const lines = [
		oneLine(meta.description),
		`Phases: ${formatMessagePhases(meta.phases)}`,
		`Source: ${formatSourceText(info)}`,
	];
	if (info.args) lines.push(`Args: ${quoteArgs(info.args)}`);
	const budgetTokens = info.budgetTokens !== undefined ? info.budgetTokens : limits.budgetTokens;
	lines.push(formatLimitsLine(limits, budgetTokens));
	lines.push("Each agent is a separate paid model session. Tool calls inside agents still follow permission rules.");

	const operation = `workflow ${meta.name}: ${formatOperationPhases(meta.phases)}${
		info.args ? `; args ${quoteArgs(info.args)}` : ""
	}`;

	return { title: `Run workflow "${meta.name}"?`, message: lines.join("\n"), operation };
}

export function describeInvalidWorkflow(message: string, info: WorkflowApprovalInfo): ApprovalDescription {
	return {
		title: "Run workflow (invalid meta)?",
		message: `The meta block is invalid: ${oneLine(message)}. Approving fails before any agent starts.`,
		operation: `workflow (invalid meta): ${formatSourceText(info)}`,
	};
}

function formatSavedWorkflowPath(filePath: string, source: "project" | "user", cwd: string): string {
	if (source === "project") {
		const baseCwd = realPathStrict(cwd) ?? cwd;
		const rel = path.relative(baseCwd, filePath);
		return path.isAbsolute(rel) ? filePath : rel;
	}
	const home = os.homedir();
	if (filePath === home || filePath.startsWith(`${home}${path.sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function readStringField(input: Record<string, unknown>, field: string): string | undefined {
	const value = input[field];
	return typeof value === "string" ? value : undefined;
}

/** Only "workflow" (inline script or saved name); undefined for every other tool and for unknown saved names. Never throws. */
export function describeToolCallForApproval(
	toolName: string,
	input: Record<string, unknown>,
	context: ApprovalContext,
): ApprovalDescription | undefined {
	try {
		if (toolName !== WORKFLOW_TOOL_NAME) return undefined;

		const args = readStringField(input, "args") ?? "";
		const script = readStringField(input, "script");
		if (script !== undefined) {
			const info: WorkflowApprovalInfo = {
				source: "inline",
				scriptLines: countScriptLines(script),
				args,
				budgetTokens: resolveBudgetTokens(input, context.limits),
			};
			const extraction = extractWorkflowMeta(script);
			if (!extraction.ok) {
				return describeInvalidWorkflow(`${extraction.error.message} (line ${extraction.error.line})`, info);
			}
			return describeWorkflowForApproval(extraction.meta, info, context.limits);
		}

		const name = readStringField(input, "name");
		if (name === undefined) return undefined;

		const workflow = findSavedWorkflow(name, {
			cwd: context.cwd,
			agentDir: context.agentDir,
			projectTrusted: context.projectTrusted,
		});
		if (workflow === undefined) return undefined;

		const info: WorkflowApprovalInfo = {
			source: workflow.source,
			path: formatSavedWorkflowPath(workflow.path, workflow.source, context.cwd),
			args,
			budgetTokens: resolveBudgetTokens(input, context.limits),
		};
		if (!workflow.valid) return describeInvalidWorkflow(workflow.error ?? "invalid meta block", info);

		const meta: WorkflowMeta = { name: workflow.name, description: workflow.description, phases: workflow.phases };
		if (workflow.whenToUse !== undefined) meta.whenToUse = workflow.whenToUse;
		return describeWorkflowForApproval(meta, info, context.limits);
	} catch {
		return undefined;
	}
}
