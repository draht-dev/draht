/**
 * Run lanes — the DATA layer behind spec §6/§13's "run rendering" row (ACP
 * tool-call + plan updates → generic lanes; a recognizer upgrades draht/
 * Claude-Task-style calls to typed lanes). This is structures + pure
 * transforms only; no UI (geist-console has no components yet, R39-M7).
 *
 * BOUNDARY (spec §7, §17.1): geist-core never speaks ACP. geist-acp emits
 * `ToolCallEvent`/`PlanUpdateEvent` whose `raw` fields are ACP wire types
 * (`ToolCall`/`ToolCallUpdate`/`Plan`). We deliberately define our OWN minimal
 * inputs here — the same "mirror, don't import" discipline already used for
 * `ElementContext`/picker (Phase 34) and the permission adapter (Phase 35a).
 * These structurally mirror geist-acp's shapes MINUS the `raw` field, so
 * geist-core stays harness-free and ACP-free. Adapting a real `ToolCallEvent`
 * into this shape at the composition root is later-phase wiring.
 */

/**
 * geist-core's ACP-free mirror of the fields geist-acp surfaces over
 * `onToolCall`, minus the ACP-typed `raw` payload. `kind` here is the ACP
 * tool-call *kind* (e.g. `read`/`edit`/`execute`), an opaque string to
 * geist-core.
 */
export interface GenericToolCallEvent {
	readonly toolCallId: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	/** `true` for a tool-call update, `false` for an initial tool call. */
	readonly isUpdate: boolean;
}

/** One plan step — the ACP-free mirror of a plan entry, minus the `raw` field. */
export interface GenericPlanEntry {
	readonly content: string;
	readonly status?: string;
	readonly priority?: string;
}

/**
 * geist-core's ACP-free mirror of the fields geist-acp surfaces over
 * `onPlanUpdate`, minus the ACP-typed `raw` payload.
 */
export interface GenericPlanUpdateEvent {
	readonly entries: readonly GenericPlanEntry[];
}

/**
 * Fields common to every tool-derived lane. `toolKind` is the tool-call kind
 * renamed off `kind` so it never collides with a lane's own `kind`
 * discriminant.
 */
export interface ToolLaneBase {
	readonly toolCallId: string;
	readonly title?: string;
	readonly toolKind?: string;
	readonly status?: string;
	readonly isUpdate: boolean;
}

/** A tool call with no recognized harness convention — the default lane. */
export interface GenericToolLane extends ToolLaneBase {
	readonly kind: "generic";
}

/**
 * A tool call a recognizer upgraded to the "subagent" typed lane (spec §6:
 * draht/Claude-Task-style sub-agent-spawning calls). `recognizedBy` records
 * which data-driven recognizer entry fired; `subagentType` is a best-effort
 * descriptor pulled from the event's `title` (the raw ACP payload is not
 * available to geist-core), absent when nothing parseable was found.
 */
export interface SubagentLane extends ToolLaneBase {
	readonly kind: "subagent";
	readonly recognizedBy: string;
	readonly subagentType?: string;
}

/** A plan update rendered as a lane (spec §6: plan updates → generic lanes). */
export interface PlanLane {
	readonly kind: "plan";
	readonly entries: readonly GenericPlanEntry[];
}

/**
 * A run lane. Discriminated on `kind` so callers can tell a generic tool lane,
 * a recognized typed lane, and a plan lane apart with an exhaustive switch.
 */
export type Lane = GenericToolLane | SubagentLane | PlanLane;

/**
 * Builds the fields shared by every tool-derived lane. Optional fields are
 * omitted (not set to `undefined`) so lanes serialize cleanly and compare by
 * value without depending on `undefined`-property semantics.
 */
export function toToolLaneBase(event: GenericToolCallEvent): ToolLaneBase {
	return {
		toolCallId: event.toolCallId,
		isUpdate: event.isUpdate,
		...(event.title !== undefined && { title: event.title }),
		...(event.kind !== undefined && { toolKind: event.kind }),
		...(event.status !== undefined && { status: event.status }),
	};
}

/**
 * Produces the default, un-upgraded lane for a tool call: a generic lane for
 * every harness (spec §6). {@link recognizeSubagentLane} runs this first, then
 * consults the recognizer table for a typed upgrade.
 */
export function toLane(event: GenericToolCallEvent): GenericToolLane {
	return { kind: "generic", ...toToolLaneBase(event) };
}

/** Renders a plan update as a plan lane (spec §6: plan updates → lanes). */
export function toPlanLane(event: GenericPlanUpdateEvent): PlanLane {
	return { kind: "plan", entries: event.entries };
}
