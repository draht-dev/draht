/**
 * Tool-row renderers for `subagent` and `workflow` (§11.5): lazy call previews, result blocks
 * reused from the live store or persisted details, the legacy fallback for old sessions, and the
 * `polyphase-workflow` custom-message renderer. No timers anywhere (§11.2.5): rows re-render on
 * emitter updates (at least every second via the heartbeat), never from a renderer-owned clock.
 */

import type { AgentToolResult } from "@draht/agent-core";
import { type Component, Text } from "@draht/tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { MessageRenderer, ToolRenderContext, ToolRenderResultOptions } from "../../extensions/types.ts";
import { isPolyphaseDetails } from "../details.ts";
import type { LimiterStats } from "../limiter.ts";
import type { PolyphaseStore } from "../store.ts";
import type { PolyphaseDetails, SubagentMode } from "../types.ts";
import { peekWorkflowMeta } from "../workflow/meta.ts";
import { fitLine, oneLine } from "./format.ts";
import { PolyphaseRunBlock, type RunLayoutOptions, sanitizeChildText } from "./run-block.ts";
import { snapshotFromDetails, snapshotFromRun } from "./snapshot.ts";

export interface PolyphaseRenderDeps {
	getStore(): PolyphaseStore | undefined;
	viewportRows(): number;
	now?(): number;
	/** Optional: when present, `(a/c slots busy)` can appear on a live tool row's summary line
	 * (§11.3). Left undefined, the suffix never shows, which matches today's wiring. */
	limiterStats?(): LimiterStats | undefined;
}

export interface SubagentCallArgs {
	agent?: string;
	task?: string;
	label?: string;
	model?: string;
	thinking?: string;
	tasks?: Array<{ agent?: string; task?: string; label?: string; model?: string }>;
	chain?: Array<{ agent?: string; task?: string; label?: string; model?: string }>;
	worktree?: boolean;
}

export interface WorkflowCallArgs {
	script?: string;
	name?: string;
	args?: string;
	budgetTokens?: number;
}

export interface PolyphaseRowState {
	hasResult?: boolean;
}

type PolyphaseCallArgs = SubagentCallArgs | WorkflowCallArgs;

function extractTextOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function subagentTitleLine(args: SubagentCallArgs, theme: Theme): string {
	if (args.chain?.length) {
		const names = args.chain.map((step) => step.agent ?? "?").join(" → ");
		return `${theme.fg("toolTitle", theme.bold("subagent chain"))} ${theme.fg("accent", names)}`;
	}
	if (args.tasks?.length) {
		return `${theme.fg("toolTitle", theme.bold("subagent parallel"))} ${theme.fg("muted", `· ${args.tasks.length} agents`)}`;
	}
	if (args.agent) {
		return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)}`;
	}
	return theme.fg("toolTitle", theme.bold("subagent"));
}

interface PreviewItem {
	agent?: string;
	task?: string;
	label?: string;
	model?: string;
}

function subagentPreviewLines(args: SubagentCallArgs, theme: Theme): string[] {
	const lines = [subagentTitleLine(args, theme)];
	const items: readonly PreviewItem[] =
		args.chain ??
		args.tasks ??
		(args.agent !== undefined ? [{ agent: args.agent, task: args.task, label: args.label, model: args.model }] : []);
	for (const item of items) {
		const label = item.label ?? item.agent ?? "?";
		const agentName = item.agent ?? "?";
		const task = item.task ? oneLine(item.task) : "";
		const modelSuffix = item.model ? ` · ${item.model}` : "";
		const taskSuffix = task ? ` ${theme.fg("toolOutput", task)}` : "";
		lines.push(`  ${theme.fg("accent", label)} (${agentName})${taskSuffix}${modelSuffix}`);
	}
	return lines;
}

function workflowTitleLine(args: WorkflowCallArgs, theme: Theme): string {
	if (args.name) {
		return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", sanitizeChildText(args.name))}`;
	}
	const peek = peekWorkflowMeta(args.script ?? "");
	if (peek.name) {
		const description = peek.description ? ` — ${sanitizeChildText(peek.description)}` : "";
		return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", sanitizeChildText(peek.name))}${theme.fg("muted", description)}`;
	}
	return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("muted", `· writing script… ${peek.lines} lines`)}`;
}

function workflowPreviewLines(args: WorkflowCallArgs, theme: Theme, expanded: boolean): string[] {
	const lines = [workflowTitleLine(args, theme)];
	const peek = peekWorkflowMeta(args.script ?? "");
	if (peek.name && peek.phases && peek.phases.length > 0) {
		const phasesText = peek.phases.map((title, index) => `${index + 1} ${sanitizeChildText(title)}`).join(" · ");
		const argsSuffix = args.args
			? ` ${theme.fg("muted", `args ${JSON.stringify(sanitizeChildText(args.args))}`)}`
			: "";
		lines.push(`    ${theme.fg("muted", "phases")} ${phasesText}${argsSuffix}`);
	}
	if (expanded && args.script) {
		for (const line of args.script.split("\n").slice(0, 60)) {
			lines.push(`    ${theme.fg("dim", "│")} ${sanitizeChildText(line)}`);
		}
	}
	return lines;
}

/** Lazily decides, at render time, whether to show the title line only (once execution has
 * started, or `renderResult` already ran once — for resumed rows) or the call preview (§11.5).
 * Generic over its `titleLine`/`previewLines` pair rather than a `kind` discriminant, so the two
 * concrete subclasses below need no cast to narrow `args` back from a union. */
class PolyphaseCallView<TArgs> implements Component {
	private readonly titleLine: (args: TArgs, theme: Theme) => string;
	private readonly previewLines: (args: TArgs, theme: Theme, expanded: boolean) => string[];
	private args: TArgs | undefined;
	private theme: Theme | undefined;
	private context: ToolRenderContext<PolyphaseRowState, TArgs> | undefined;
	// Recomputing scans the script for its meta header and, when expanded, re-splits it into lines
	// (peekWorkflowMeta, workflowPreviewLines): work that must happen once per args update, never
	// once per frame. `args` is replaced wholesale whenever the tool-call JSON actually changes, so
	// reference equality is enough to detect "nothing changed since the last render".
	private cachedArgs: TArgs | undefined;
	private cachedShowTitleOnly: boolean | undefined;
	private cachedExpanded: boolean | undefined;
	private cachedLines: string[] = [];

	constructor(
		titleLine: (args: TArgs, theme: Theme) => string,
		previewLines: (args: TArgs, theme: Theme, expanded: boolean) => string[],
	) {
		this.titleLine = titleLine;
		this.previewLines = previewLines;
	}

	update(args: TArgs, theme: Theme, context: ToolRenderContext<PolyphaseRowState, TArgs>): void {
		this.args = args;
		this.theme = theme;
		this.context = context;
	}

	render(width: number): string[] {
		if (this.args === undefined || !this.theme || !this.context) return [];
		const args = this.args;
		const theme = this.theme;
		const context = this.context;
		const showTitleOnly = context.state.hasResult === true || context.executionStarted;
		if (
			args !== this.cachedArgs ||
			showTitleOnly !== this.cachedShowTitleOnly ||
			context.expanded !== this.cachedExpanded
		) {
			this.cachedArgs = args;
			this.cachedShowTitleOnly = showTitleOnly;
			this.cachedExpanded = context.expanded;
			this.cachedLines = showTitleOnly
				? [this.titleLine(args, theme)]
				: this.previewLines(args, theme, context.expanded);
		}
		return this.cachedLines.map((line) => fitLine(line, width));
	}

	invalidate(): void {
		this.cachedArgs = undefined;
	}
}

class SubagentCallView extends PolyphaseCallView<SubagentCallArgs> {
	constructor() {
		super(subagentTitleLine, (args, theme) => subagentPreviewLines(args, theme));
	}
}

class WorkflowCallView extends PolyphaseCallView<WorkflowCallArgs> {
	constructor() {
		super(workflowTitleLine, workflowPreviewLines);
	}
}

function tailItemsFor(mode: SubagentMode | undefined): number {
	return mode === "single" ? 8 : 4;
}

function computeMaxLines(viewportRows: number, isPartial: boolean, expanded: boolean): number {
	if (isPartial) {
		return expanded ? Math.min(40, Math.max(6, viewportRows - 12)) : Math.min(12, Math.max(4, viewportRows - 12));
	}
	return expanded ? 200 : 12;
}

/** §11.2's source-selection rule: the live store run while partial and present, else details via
 * `isPolyphaseDetails`, else `undefined` to signal the legacy fallback. */
function resolveSnapshot(
	deps: PolyphaseRenderDeps,
	toolCallId: string,
	isPartial: boolean,
	details: unknown,
	now: number,
) {
	if (isPartial) {
		const run = deps.getStore()?.getRun(toolCallId);
		if (run) return snapshotFromRun(run, { now, tailItems: tailItemsFor(run.mode), limiter: deps.limiterStats?.() });
	}
	if (isPolyphaseDetails(details)) return snapshotFromDetails(details, { now });
	return undefined;
}

export function renderLegacySubagentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details;
	const status =
		typeof d === "object" && d !== null && "status" in d && typeof d.status === "string" ? d.status : undefined;
	const output = extractTextOutput(result);
	const lines: string[] = [];

	if (status) lines.push(theme.fg("muted", status));

	if (output.trim()) {
		const trimmed = output.trim();
		if (options.expanded || options.isPartial) {
			for (const line of trimmed.split("\n")) lines.push(theme.fg("toolOutput", line));
		} else {
			const allLines = trimmed.split("\n");
			const previewLines = allLines.slice(0, 8);
			lines.push(theme.fg("toolOutput", previewLines.join("\n")));
			if (allLines.length > 8) lines.push(theme.fg("muted", `... (${allLines.length - 8} more lines)`));
		}
	}

	if (lines.length === 0) return new Text("", 0, 0);
	return new Text(lines.join("\n"), 0, 0);
}

function renderLegacyWorkflowResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const output = extractTextOutput(result).trim();
	if (!output) return new Text("", 0, 0);
	const lines = output.split("\n");
	const shown = options.expanded ? lines : lines.slice(0, 8);
	const rendered = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	return new Text(rendered, 0, 0);
}

function renderPolyphaseResult(
	deps: PolyphaseRenderDeps,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<PolyphaseRowState, PolyphaseCallArgs>,
	kind: "subagent" | "workflow",
): Component {
	const now = deps.now?.() ?? Date.now();
	const snapshot = resolveSnapshot(deps, context.toolCallId, options.isPartial, result.details, now);
	if (!snapshot) {
		return kind === "subagent"
			? renderLegacySubagentResult(result, options, theme)
			: renderLegacyWorkflowResult(result, options, theme);
	}
	context.state.hasResult = true;

	const focus = !options.isPartial || deps.getStore()?.focusRunId() === context.toolCallId;
	const maxLines = computeMaxLines(deps.viewportRows(), options.isPartial, options.expanded);
	const layoutOptions: RunLayoutOptions = {
		expanded: options.expanded,
		partial: options.isPartial,
		focus,
		maxLines,
		hints: true,
		now,
	};

	const block = context.lastComponent instanceof PolyphaseRunBlock ? context.lastComponent : new PolyphaseRunBlock();
	block.update(snapshot, theme, layoutOptions);
	return block;
}

export function createSubagentRenderers(deps: PolyphaseRenderDeps): {
	renderCall(
		args: SubagentCallArgs,
		theme: Theme,
		context: ToolRenderContext<PolyphaseRowState, SubagentCallArgs>,
	): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<PolyphaseRowState, SubagentCallArgs>,
	): Component;
} {
	return {
		renderCall(args, theme, context) {
			const view =
				context.lastComponent instanceof SubagentCallView ? context.lastComponent : new SubagentCallView();
			view.update(args, theme, context);
			return view;
		},
		renderResult(result, options, theme, context) {
			return renderPolyphaseResult(deps, result, options, theme, context, "subagent");
		},
	};
}

export function createWorkflowRenderers(deps: PolyphaseRenderDeps): {
	renderCall(
		args: WorkflowCallArgs,
		theme: Theme,
		context: ToolRenderContext<PolyphaseRowState, WorkflowCallArgs>,
	): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<PolyphaseRowState, WorkflowCallArgs>,
	): Component;
} {
	return {
		renderCall(args, theme, context) {
			const view =
				context.lastComponent instanceof WorkflowCallView ? context.lastComponent : new WorkflowCallView();
			view.update(args, theme, context);
			return view;
		},
		renderResult(result, options, theme, context) {
			return renderPolyphaseResult(deps, result, options, theme, context, "workflow");
		},
	};
}

/** Combines a static prefix line with a `PolyphaseRunBlock`'s lines, both fitted at render time
 * (the block is built once from `details`, which never changes for a persisted custom message). */
class PrefixedRunBlock implements Component {
	private readonly prefixLine: string;
	private readonly block: PolyphaseRunBlock;

	constructor(prefixLine: string, block: PolyphaseRunBlock) {
		this.prefixLine = prefixLine;
		this.block = block;
	}

	render(width: number): string[] {
		return [fitLine(this.prefixLine, width), ...this.block.render(width)];
	}

	invalidate(): void {
		this.block.invalidate();
	}
}

/** Renders `polyphase-workflow` custom messages (command-run results) as a static block built from
 * `message.details`, prefixed with `▶ /<name> <args>` (§11.5). */
export function createPolyphaseMessageRenderer(): MessageRenderer<PolyphaseDetails> {
	return (message, options, theme) => {
		const details = message.details;
		if (!details || !isPolyphaseDetails(details)) return undefined;

		const snapshot = snapshotFromDetails(details);
		const name = details.workflow?.name ?? details.title;
		const argsSuffix = details.workflow?.args ? ` ${details.workflow.args}` : "";
		const prefixLine = `${theme.fg("accent", "▶")} ${theme.fg("toolTitle", `/${name}${argsSuffix}`)}`;

		const layoutOptions: RunLayoutOptions = {
			expanded: options.expanded,
			partial: false,
			focus: false,
			maxLines: options.expanded ? 200 : 12,
			hints: false,
			now: Date.now(),
		};
		const block = new PolyphaseRunBlock();
		block.update(snapshot, theme, layoutOptions);
		return new PrefixedRunBlock(prefixLine, block);
	};
}
