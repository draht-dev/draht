import type { ThinkingLevel } from "@draht/agent-core";
import type { Api, Model } from "@draht/ai";
import { Text } from "@draht/tui";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { SessionEntry } from "../session-manager.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../tools/truncate.ts";
import { type AgentConfig, type RunResult, runParallelTasks } from "./subagent.ts";

export type DuetStrategy = "turns" | "triage";

export interface DuetParticipant {
	role: string;
	model: Model<Api>;
	modelRef: string;
	thinkingLevel?: ThinkingLevel;
}

export interface DuetState {
	strategy: DuetStrategy;
	participants: DuetParticipant[];
	nextIndex: number;
}

interface PersistedDuetParticipant {
	role: string;
	modelRef: string;
	thinkingLevel?: ThinkingLevel;
}

interface PersistedDuetState {
	version: 1;
	enabled: boolean;
	strategy?: DuetStrategy;
	participants?: PersistedDuetParticipant[];
	nextIndex?: number;
}

interface DuetDelegateDetails {
	results: Array<{ participant: string; exitCode: number }>;
	status?: string;
}

const DUET_STATE_ENTRY = "duet-state";
const DUET_DELEGATE_TOOL = "duet_delegate";
const MAX_DUET_PARTICIPANTS = 8;
const READ_ONLY_TEAMMATE_TOOLS = ["read", "grep", "find", "ls"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isDuetStrategy(value: unknown): value is DuetStrategy {
	return value === "turns" || value === "triage";
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sanitizeRole(value: string): string {
	let role = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!role) return "teammate";
	if (!/^[a-z]/.test(role)) role = `model-${role}`;
	return role.slice(0, 42);
}

function validateExplicitRole(role: string): void {
	if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(role)) {
		throw new Error(`Invalid duet role "${role}". Use 1-48 letters, numbers, underscores, or hyphens.`);
	}
}

function uniqueDefaultRole(model: Model<Api>, usedRoles: Set<string>): string {
	const shortRole = sanitizeRole(model.id.split("/").pop() ?? model.id);
	if (!usedRoles.has(shortRole)) return shortRole;

	const providerRole = sanitizeRole(`${model.provider}-${model.id}`);
	if (!usedRoles.has(providerRole)) return providerRole;

	let suffix = 2;
	while (true) {
		const suffixText = `-${suffix}`;
		const candidate = `${providerRole.slice(0, 48 - suffixText.length)}${suffixText}`;
		if (!usedRoles.has(candidate)) return candidate;
		suffix++;
	}
}

/** Resolve comma-separated `[role=]provider/model[:thinking]` participant specifications. */
export function parseDuetParticipantSpecs(specs: string, availableModels: Model<Api>[]): DuetParticipant[] {
	const rawSpecs = specs
		.split(",")
		.map((spec) => spec.trim())
		.filter(Boolean);

	if (rawSpecs.length < 2) throw new Error("Duet mode requires at least two models.");
	if (rawSpecs.length > MAX_DUET_PARTICIPANTS) {
		throw new Error(`Duet mode supports at most ${MAX_DUET_PARTICIPANTS} models.`);
	}

	const participants: DuetParticipant[] = [];
	const usedModels = new Set<string>();
	const usedRoles = new Set<string>();

	for (const rawSpec of rawSpecs) {
		const equalsIndex = rawSpec.indexOf("=");
		const explicitRole = equalsIndex === -1 ? undefined : rawSpec.slice(0, equalsIndex).trim();
		const modelSpec = equalsIndex === -1 ? rawSpec : rawSpec.slice(equalsIndex + 1).trim();

		if (explicitRole !== undefined) validateExplicitRole(explicitRole);
		if (!modelSpec) throw new Error(`Missing model in duet participant "${rawSpec}".`);

		const resolved = parseModelPattern(modelSpec, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (!resolved.model) {
			throw new Error(`Duet model "${modelSpec}" is unavailable. Authenticate it or use /scoped-models.`);
		}

		const key = modelKey(resolved.model);
		if (usedModels.has(key)) throw new Error(`Duet model "${key}" was selected more than once.`);

		const role = explicitRole || uniqueDefaultRole(resolved.model, usedRoles);
		if (usedRoles.has(role)) throw new Error(`Duet role "${role}" was selected more than once.`);

		usedModels.add(key);
		usedRoles.add(role);
		participants.push({
			role,
			model: resolved.model,
			modelRef: key,
			thinkingLevel: resolved.thinkingLevel,
		});
	}

	return participants;
}

export function advanceDuetTurn(state: DuetState): DuetParticipant {
	const index =
		((state.nextIndex % state.participants.length) + state.participants.length) % state.participants.length;
	const participant = state.participants[index];
	state.nextIndex = (index + 1) % state.participants.length;
	return participant;
}

function participantsFromScopedModels(ctx: ExtensionContext): DuetParticipant[] {
	if (ctx.scopedModels.length < 2) {
		throw new Error("Pass models to /duet or configure at least two models with /scoped-models.");
	}
	const specs = ctx.scopedModels
		.map(({ model, thinkingLevel }) => `${modelKey(model)}${thinkingLevel ? `:${thinkingLevel}` : ""}`)
		.join(",");
	return parseDuetParticipantSpecs(specs, ctx.modelRegistry.getAvailable());
}

function toPersistedState(state: DuetState | undefined): PersistedDuetState {
	if (!state) return { version: 1, enabled: false };
	return {
		version: 1,
		enabled: true,
		strategy: state.strategy,
		participants: state.participants.map(({ role, modelRef, thinkingLevel }) => ({
			role,
			modelRef,
			thinkingLevel,
		})),
		nextIndex: state.nextIndex,
	};
}

function isPersistedParticipant(value: unknown): value is PersistedDuetParticipant {
	if (typeof value !== "object" || value === null) return false;
	const participant = value as Record<string, unknown>;
	return (
		typeof participant.role === "string" &&
		typeof participant.modelRef === "string" &&
		(participant.thinkingLevel === undefined || isThinkingLevel(participant.thinkingLevel))
	);
}

function isPersistedState(value: unknown): value is PersistedDuetState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	if (state.version !== 1 || typeof state.enabled !== "boolean") return false;
	if (!state.enabled) return true;
	return (
		isDuetStrategy(state.strategy) &&
		Array.isArray(state.participants) &&
		state.participants.every(isPersistedParticipant) &&
		(state.nextIndex === undefined || (typeof state.nextIndex === "number" && Number.isInteger(state.nextIndex)))
	);
}

function restoreState(value: PersistedDuetState, availableModels: Model<Api>[]): DuetState | undefined {
	if (!value.enabled || !value.strategy || !value.participants) return undefined;
	const specs = value.participants
		.map(({ role, modelRef, thinkingLevel }) => `${role}=${modelRef}${thinkingLevel ? `:${thinkingLevel}` : ""}`)
		.join(",");
	const participants = parseDuetParticipantSpecs(specs, availableModels);
	return {
		strategy: value.strategy,
		participants,
		nextIndex: Math.max(0, value.nextIndex ?? 0) % participants.length,
	};
}

export function restoreDuetTurnFromBranch(state: DuetState, branch: readonly SessionEntry[]): void {
	if (state.strategy !== "turns") return;
	let stateEntryIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === DUET_STATE_ENTRY) {
			stateEntryIndex = index;
			break;
		}
	}
	for (let index = branch.length - 1; index > stateEntryIndex; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const participantIndex = state.participants.findIndex(
			(participant) => participant.model.provider === message.provider && participant.model.id === message.model,
		);
		if (participantIndex !== -1) state.nextIndex = (participantIndex + 1) % state.participants.length;
		return;
	}
}

function formatParticipant(participant: DuetParticipant): string {
	return `${participant.role}=${participant.modelRef}${participant.thinkingLevel ? `:${participant.thinkingLevel}` : ""}`;
}

export function buildDuetSystemPrompt(state: DuetState, activeParticipant?: DuetParticipant): string {
	if (state.strategy === "turns") {
		const participant = activeParticipant ?? state.participants[0];
		return [
			"You are working in Draht duet turn-taking mode.",
			`Your role for this turn is "${participant.role}" using ${participant.modelRef}.`,
			"Other duet models share this same persisted conversation, tool history, and working tree.",
			"Build on their work, state disagreements directly, and leave the session in a useful state for the next model.",
		].join("\n");
	}

	const lead = state.participants[0];
	const teammates = state.participants.slice(1).map(formatParticipant).join(", ");
	return [
		"You are the lead in Draht duet triage mode.",
		`Lead role: ${formatParticipant(lead)}. Read-only teammates: ${teammates}.`,
		"For non-trivial requests, triage the work into independent investigations and use duet_delegate once to run useful assignments in parallel.",
		"Assignments must be self-contained and should request evidence, file paths, risks, or recommendations rather than edits.",
		"Teammates cannot modify files. Synthesize their results, resolve disagreements, and perform all edits and commands in the shared session yourself.",
		"Skip delegation for trivial work where it would only add latency or cost.",
	].join("\n");
}

export function createDuetTeammateAgent(participant: DuetParticipant): AgentConfig {
	return {
		name: participant.role,
		description: `Read-only duet teammate using ${participant.modelRef}`,
		model: `${participant.modelRef}${participant.thinkingLevel ? `:${participant.thinkingLevel}` : ""}`,
		tools: [...READ_ONLY_TEAMMATE_TOOLS],
		disableExtensions: true,
		source: "user",
		systemPrompt: [
			`You are "${participant.role}", a read-only teammate in a Draht duet session.`,
			"Investigate only the assignment from the lead. Use read-only tools as needed.",
			"Do not modify files and do not ask the user questions.",
			"Return concise findings with evidence, file paths, risks, and a concrete recommendation for the lead.",
		].join("\n"),
	};
}

export function combineDuetUsage(results: RunResult[]): RunResult["usage"] {
	const usages = results.map((result) => result.usage).filter((usage) => usage !== undefined);
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

function truncateParticipantOutput(output: string): string {
	const truncated = truncateHead(output, {
		maxBytes: Math.floor(DEFAULT_MAX_BYTES / 2),
		maxLines: Math.floor(DEFAULT_MAX_LINES / 2),
	});
	if (!truncated.truncated) return output;
	return `${truncated.content}\n\n[Participant output truncated: showing ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.]`;
}

function formatDelegateResults(results: RunResult[]): string {
	const successful = results.filter((result) => result.exitCode === 0).length;
	const sections = results.map((result) => {
		const status = result.exitCode === 0 ? "completed" : "failed";
		const output = truncateParticipantOutput(result.output || result.stderr || "(no output)");
		return `## ${result.agent} (${status})\n\n${output}`;
	});
	const fullOutput = `Duet delegation: ${successful}/${results.length} completed\n\n${sections.join("\n\n---\n\n")}`;
	const truncated = truncateHead(fullOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return fullOutput;
	return `${truncated.content}\n\n[Duet output truncated: showing ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.]`;
}

const DuetAssignment = Type.Object({
	participant: Type.String({ description: "Configured teammate role to receive this assignment" }),
	task: Type.String({ description: "Self-contained read-only investigation for the teammate" }),
});

const DuetDelegateParams = Type.Object({
	assignments: Type.Array(DuetAssignment, {
		description: "Independent assignments to run concurrently, at most one per teammate",
		minItems: 1,
		maxItems: MAX_DUET_PARTICIPANTS - 1,
	}),
});

export default function duetBuiltin(pi: ExtensionAPI) {
	let state: DuetState | undefined;
	let activeTurnParticipant: DuetParticipant | undefined;
	let pendingTurnParticipant: DuetParticipant | undefined;
	let runningTurnParticipant: DuetParticipant | undefined;
	let delegatedForPrompt = false;
	let selectingParticipant = false;

	pi.registerFlag("duet", {
		description: "Comma-separated duet models: [role=]provider/model[:thinking]",
		type: "string",
	});
	pi.registerFlag("duet-strategy", {
		description: "Duet strategy: turns or triage",
		type: "string",
		default: "triage",
	});

	function persistState() {
		pi.appendEntry(DUET_STATE_ENTRY, toPersistedState(state));
	}

	function setDelegateToolActive(active: boolean): boolean {
		if (active && !registerDuetDelegateTool()) return false;
		if (!active && !duetDelegateToolRegistered) return true;
		const names = pi.getActiveTools().filter((name) => name !== DUET_DELEGATE_TOOL);
		if (active) names.push(DUET_DELEGATE_TOOL);
		pi.setActiveTools(names);
		return pi.getActiveTools().includes(DUET_DELEGATE_TOOL) === active;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!state) {
			ctx.ui.setStatus("duet", undefined);
			return;
		}
		const role = state.strategy === "triage" ? state.participants[0].role : activeTurnParticipant?.role;
		ctx.ui.setStatus("duet", `duet:${state.strategy}${role ? ` ${role}` : ""}`);
	}

	async function setParticipantModel(participant: DuetParticipant, ctx: ExtensionContext): Promise<boolean> {
		selectingParticipant = true;
		try {
			if (!ctx.model || modelKey(ctx.model) !== participant.modelRef) {
				const selected = await pi.setModel(participant.model, { persistDefault: false });
				if (!selected) {
					ctx.ui.notify(`No authentication available for ${participant.modelRef}`, "error");
					return false;
				}
			}
			if (participant.thinkingLevel && ctx.thinkingLevel !== participant.thinkingLevel) {
				pi.setThinkingLevel(participant.thinkingLevel, { persistDefault: false });
			}
			return true;
		} catch (error) {
			ctx.ui.notify(
				`Could not select duet participant ${participant.role}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		} finally {
			selectingParticipant = false;
		}
	}

	async function enableDuet(
		strategy: DuetStrategy,
		participants: DuetParticipant[],
		ctx: ExtensionContext,
		persist: boolean,
	): Promise<boolean> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the active response to finish before changing duet mode.", "warning");
			return false;
		}

		const previousState = state;
		const previousActiveParticipant = activeTurnParticipant;
		state = { strategy, participants, nextIndex: 0 };
		activeTurnParticipant =
			strategy === "triage"
				? participants[0]
				: participants.find(
						(participant) => participant.modelRef === (ctx.model ? modelKey(ctx.model) : undefined),
					);
		pendingTurnParticipant = undefined;
		runningTurnParticipant = undefined;

		if (strategy === "triage") {
			const extensionProviders = new Set(ctx.modelRegistry.getRegisteredProviderIds());
			const unsupported = participants
				.slice(1)
				.filter((participant) => extensionProviders.has(participant.model.provider));
			if (unsupported.length > 0) {
				state = previousState;
				activeTurnParticipant = previousActiveParticipant;
				ctx.ui.notify(
					`Duet teammates cannot use extension-provided models because teammate extensions are disabled: ${unsupported.map(formatParticipant).join(", ")}`,
					"error",
				);
				return false;
			}
		}

		if (!setDelegateToolActive(strategy === "triage")) {
			state = previousState;
			activeTurnParticipant = previousActiveParticipant;
			ctx.ui.notify(
				`Cannot enable duet triage because ${DUET_DELEGATE_TOOL} is excluded by the active tool configuration.`,
				"error",
			);
			return false;
		}

		if (strategy === "triage" && !(await setParticipantModel(participants[0], ctx))) {
			state = previousState;
			activeTurnParticipant = previousActiveParticipant;
			setDelegateToolActive(previousState?.strategy === "triage");
			return false;
		}

		if (persist) persistState();
		updateStatus(ctx);
		return true;
	}

	function disableDuet(ctx: ExtensionContext, persist: boolean): boolean {
		if (persist && !ctx.isIdle()) {
			ctx.ui.notify("Wait for the active response to finish before changing duet mode.", "warning");
			return false;
		}

		state = undefined;
		activeTurnParticipant = undefined;
		pendingTurnParticipant = undefined;
		runningTurnParticipant = undefined;
		delegatedForPrompt = false;
		setDelegateToolActive(false);
		if (persist) persistState();
		updateStatus(ctx);
		return true;
	}

	async function restoreDuetFromBranch(ctx: ExtensionContext): Promise<void> {
		disableDuet(ctx, false);
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((candidate) => candidate.type === "custom" && candidate.customType === DUET_STATE_ENTRY);
		if (!entry || entry.type !== "custom" || !isPersistedState(entry.data) || !entry.data.enabled) return;

		try {
			const restored = restoreState(entry.data, ctx.modelRegistry.getAvailable());
			if (restored && (await enableDuet(restored.strategy, restored.participants, ctx, false))) {
				restoreDuetTurnFromBranch(restored, ctx.sessionManager.getBranch());
				state = restored;
			}
		} catch (error) {
			disableDuet(ctx, false);
			ctx.ui.notify(
				`Could not restore duet mode: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	let duetDelegateToolRegistered = false;
	function registerDuetDelegateTool(): boolean {
		if (duetDelegateToolRegistered) return true;
		if (pi.getAllTools().some((tool) => tool.name === DUET_DELEGATE_TOOL)) return false;
		pi.registerTool({
			name: DUET_DELEGATE_TOOL,
			label: "Duet Delegate",
			description:
				"Delegate independent, read-only investigations to configured duet teammates in parallel. Available only in duet triage mode.",
			parameters: DuetDelegateParams,
			renderCall(args, theme) {
				const lines = [theme.fg("toolTitle", theme.bold(`duet delegate (${args.assignments.length})`))];
				for (const assignment of args.assignments) {
					lines.push(`  ${theme.fg("accent", assignment.participant)} ${theme.fg("toolOutput", assignment.task)}`);
				}
				return new Text(lines.join("\n"), 0, 0);
			},
			renderResult(result, options, theme) {
				const details = result.details as DuetDelegateDetails | undefined;
				const text = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (options.isPartial && details?.status) return new Text(theme.fg("muted", details.status), 0, 0);
				const lines = text.split("\n");
				const visible = options.expanded ? lines : lines.slice(0, 10);
				if (!options.expanded && lines.length > visible.length)
					visible.push(`... (${lines.length - visible.length} more lines)`);
				return new Text(theme.fg("toolOutput", visible.join("\n")), 0, 0);
			},
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!state || state.strategy !== "triage") {
					return {
						content: [
							{ type: "text" as const, text: "Duet triage mode is not enabled. Use /duet triage first." },
						],
						details: { results: [] },
					};
				}

				if (delegatedForPrompt) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Duet delegation already ran for this user prompt. Synthesize the existing teammate results.",
							},
						],
						details: { results: [] },
					};
				}

				const teammates = new Map(
					state.participants.slice(1).map((participant) => [participant.role, participant]),
				);
				const assignedRoles = new Set<string>();
				const items: Array<{ agent: AgentConfig; task: string }> = [];
				for (const assignment of params.assignments) {
					const participant = teammates.get(assignment.participant);
					if (!participant) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Unknown duet teammate "${assignment.participant}". Available: ${[...teammates.keys()].join(", ")}`,
								},
							],
							details: { results: [] },
						};
					}
					if (assignedRoles.has(participant.role)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Participant "${participant.role}" can receive only one assignment per delegation.`,
								},
							],
							details: { results: [] },
						};
					}
					assignedRoles.add(participant.role);
					items.push({ agent: createDuetTeammateAgent(participant), task: assignment.task });
				}
				delegatedForPrompt = true;

				const activity = new Map<string, string>();
				const results = await runParallelTasks(ctx.cwd, items, {
					signal,
					makeOnProgress: (role) => (message) => {
						activity.set(role, message);
						onUpdate?.({
							content: [
								{
									type: "text" as const,
									text: [...activity].map(([name, text]) => `${name}: ${text}`).join("\n"),
								},
							],
							details: {
								results: [],
								status: `${activity.size}/${items.length} teammates active`,
							},
						});
					},
				});

				return {
					content: [{ type: "text" as const, text: formatDelegateResults(results) }],
					usage: combineDuetUsage(results),
					details: {
						results: results.map((result) => ({ participant: result.agent, exitCode: result.exitCode })),
					},
				};
			},
		});
		duetDelegateToolRegistered = true;
		return true;
	}

	pi.registerCommand("duet", {
		description: "Configure multi-model collaboration. Usage: /duet [turns|triage] [[role=]model,...] | off | status",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				if (!state) {
					ctx.ui.notify("Duet mode is off.", "info");
					return;
				}
				ctx.ui.notify(`Duet ${state.strategy}: ${state.participants.map(formatParticipant).join(", ")}`, "info");
				return;
			}

			if (["off", "none", "clear"].includes(trimmed)) {
				if (disableDuet(ctx, true)) ctx.ui.notify("Duet mode disabled.", "info");
				return;
			}

			const firstSpace = trimmed.indexOf(" ");
			const strategyText = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
			if (!isDuetStrategy(strategyText)) {
				ctx.ui.notify("Usage: /duet [turns|triage] [[role=]provider/model,...] | off | status", "error");
				return;
			}

			try {
				const specs = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
				const participants = specs
					? parseDuetParticipantSpecs(specs, ctx.modelRegistry.getAvailable())
					: participantsFromScopedModels(ctx);
				if (await enableDuet(strategyText, participants, ctx, true)) {
					ctx.ui.notify(`Duet ${strategyText} enabled: ${participants.map(formatParticipant).join(", ")}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
		getArgumentCompletions: (partial) => {
			const options = ["status", "off", "turns", "triage"];
			return options
				.filter((option) => option.startsWith(partial))
				.map((option) => ({ value: option, label: option }));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		disableDuet(ctx, false);

		const duetFlag = pi.getFlag("duet");
		const strategyFlag = pi.getFlag("duet-strategy");
		if (typeof duetFlag === "string" && duetFlag.trim()) {
			if (!isDuetStrategy(strategyFlag)) {
				ctx.ui.notify(`Invalid --duet-strategy "${String(strategyFlag)}". Use turns or triage.`, "error");
				return;
			}
			try {
				const participants = parseDuetParticipantSpecs(duetFlag, ctx.modelRegistry.getAvailable());
				await enableDuet(strategyFlag, participants, ctx, true);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}

		await restoreDuetFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => restoreDuetFromBranch(ctx));

	pi.on("input", async (event, ctx) => {
		if (!state || !ctx.isIdle() || event.text.startsWith("!")) return { action: "continue" as const };

		const participant = state.strategy === "triage" ? state.participants[0] : state.participants[state.nextIndex];
		if (!(await setParticipantModel(participant, ctx))) return { action: "handled" as const };

		activeTurnParticipant = participant;
		pendingTurnParticipant = state.strategy === "turns" ? participant : undefined;
		updateStatus(ctx);
		return { action: "continue" as const };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!state || state.strategy !== "turns" || !pendingTurnParticipant) return;
		runningTurnParticipant = pendingTurnParticipant;
		activeTurnParticipant = pendingTurnParticipant;
		pendingTurnParticipant = undefined;
		updateStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state || state.strategy !== "turns" || !runningTurnParticipant) return;
		const participantIndex = state.participants.findIndex(
			(participant) => participant.role === runningTurnParticipant?.role,
		);
		if (participantIndex !== -1) state.nextIndex = (participantIndex + 1) % state.participants.length;
		runningTurnParticipant = undefined;
		updateStatus(ctx);
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") delegatedForPrompt = false;
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!state || selectingParticipant) return;
		const expected =
			state.strategy === "triage"
				? state.participants[0]
				: (runningTurnParticipant ?? pendingTurnParticipant ?? activeTurnParticipant);
		if (!expected?.thinkingLevel || event.level === expected.thinkingLevel) return;
		ctx.ui.notify(
			`Duet mode keeps the thinking level on ${expected.thinkingLevel} for ${expected.role}. Use /duet off to change it freely.`,
			"warning",
		);
		await setParticipantModel(expected, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!state || selectingParticipant) return;
		const expected =
			state.strategy === "triage"
				? state.participants[0]
				: (runningTurnParticipant ?? pendingTurnParticipant ?? activeTurnParticipant);
		if (!expected || modelKey(event.model) === expected.modelRef) return;
		ctx.ui.notify(
			`Duet mode keeps the active model on ${formatParticipant(expected)}. Use /duet off to switch freely.`,
			"warning",
		);
		await setParticipantModel(expected, ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!state) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildDuetSystemPrompt(state, activeTurnParticipant)}` };
	});
}
