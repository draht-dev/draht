/**
 * Keyword trigger for the `workflow` tool (§16.5): detects the configured keyword in idle or
 * streaming user input, registers and activates the tool for one prompt, and sends a one-time
 * authoring guide as a visible custom message. Never edits the user text or the system prompt.
 */

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import type { ResolvedPolyphaseSettings } from "./settings.ts";

const GUIDANCE_CUSTOM_TYPE = "polyphase-guidance";

/** Whole-word, case-insensitive, Unicode-aware match: the keyword must not be part of a longer word. */
export function detectKeyword(text: string, keyword: string): boolean {
	const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])${keyword}(?=$|[^\\p{L}\\p{N}_-])`, "iu");
	return pattern.test(text);
}

/** True when a `polyphase-guidance` custom message entry appears after the last compaction entry. */
export function hasGuidanceInContext(entries: readonly SessionEntry[]): boolean {
	let lastCompactionIndex = -1;
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].type === "compaction") lastCompactionIndex = i;
	}
	for (let i = lastCompactionIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "custom_message" && entry.customType === GUIDANCE_CUSTOM_TYPE) return true;
	}
	return false;
}

export interface KeywordHooks {
	onInput(event: InputEvent, ctx: ExtensionContext): InputEventResult;
	onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined;
	onAgentSettled(ctx: ExtensionContext): void;
}

export interface KeywordHooksDeps {
	pi: ExtensionAPI;
	settings(): ResolvedPolyphaseSettings;
	ensureTool(): boolean;
	activate(): void;
	deactivateIfAuto(): void;
	buildGuide(ctx: ExtensionContext): string;
}

export function createKeywordHooks(deps: KeywordHooksDeps): KeywordHooks {
	let armed = false;
	// `sendMessage({deliverAs})` on the streaming path queues the guidance into the branch instead
	// of writing it immediately (agent-session.ts sendCustomMessage routes steer/followUp to the
	// agent's queues), so `hasGuidanceInContext` cannot see it there yet. Without this flag, a
	// second keyword steer/follow-up before delivery passes the same `hasGuidanceInContext` check
	// and queues a second copy of the full authoring guide.
	let guidanceQueued = false;

	return {
		onInput(event, ctx) {
			const settings = deps.settings();
			if (
				settings.workflowTool === "off" ||
				event.source === "extension" ||
				event.text.startsWith("/") ||
				event.text.startsWith("!") ||
				!detectKeyword(event.text, settings.keyword)
			) {
				// Do nothing else (§16.5): in particular, never clear a pending `armed` arm. An
				// extension-sourced input event can land between an armed user input and the
				// `before_agent_start` that consumes it.
				return { action: "continue" };
			}

			if (event.streamingBehavior === undefined) {
				armed = true;
				return { action: "continue" };
			}

			armed = false;
			if (!deps.ensureTool()) return { action: "continue" };
			deps.activate();
			if (!guidanceQueued && !hasGuidanceInContext(ctx.sessionManager.getBranch())) {
				guidanceQueued = true;
				const guide = deps.buildGuide(ctx);
				deps.pi.sendMessage(
					{
						customType: GUIDANCE_CUSTOM_TYPE,
						content: [{ type: "text", text: guide }],
						display: true,
						details: { keyword: settings.keyword },
					},
					{ deliverAs: event.streamingBehavior },
				);
			}
			return { action: "continue" };
		},

		onBeforeAgentStart(event, ctx) {
			if (!armed) return undefined;
			armed = false;
			// The armed input and this turn's prompt should be the same text, but a handler earlier
			// in the chain (or a turn that never reached `input`, e.g. a triggered `sendMessage`) can
			// start a turn that never matched the keyword; re-check instead of trusting the stale arm.
			if (!detectKeyword(event.prompt, deps.settings().keyword)) return undefined;
			if (!deps.ensureTool()) return undefined;
			deps.activate();
			if (hasGuidanceInContext(ctx.sessionManager.getBranch())) return undefined;
			const guide = deps.buildGuide(ctx);
			return {
				message: {
					customType: GUIDANCE_CUSTOM_TYPE,
					content: [{ type: "text", text: guide }],
					display: true,
					details: { keyword: deps.settings().keyword },
				},
			};
		},

		onAgentSettled() {
			guidanceQueued = false;
			deps.deactivateIfAuto();
		},
	};
}
