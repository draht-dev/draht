import type { HarnessCapabilities } from "../harness-session.js";
import type { ElementContext } from "./element-context.js";

/**
 * Dispatch composition (spec §6 Dispatch row, §9.4): "Element → composed
 * situation prompt; image content block when capability-advertised, crop
 * always at <wt>/.geist/task-<id>/target.webp and path-referenced."
 *
 * A `SituationPrompt` is geist-core's structured, harness-agnostic dispatch
 * payload — NOT an ACP wire shape. "geist-core never speaks ACP" (spec §7);
 * `geist-acp` is responsible for translating this into whatever ACP content
 * blocks the connected harness actually expects (Phase 35, M3). This phase
 * does no image encoding/base64 — the `image` block below only ever carries
 * a path reference to the crop file already written to disk.
 */

/** The composed instruction text — the request plus its situational grounding. */
export interface SituationPromptTextBlock {
	readonly type: "text";
	readonly text: string;
}

/**
 * Present ONLY when `capabilities.images` is advertised (spec: "image
 * content block when capability-advertised"). Path-only — no inline
 * image bytes/base64 in this phase.
 */
export interface SituationPromptImageBlock {
	readonly type: "image";
	readonly path: string;
}

/**
 * Present UNCONDITIONALLY (spec: "crop always ... path-referenced") —
 * distinct from the capability-gated inline image block above.
 */
export interface SituationPromptPathReferenceBlock {
	readonly type: "path-reference";
	readonly path: string;
}

export type SituationPromptBlock =
	| SituationPromptTextBlock
	| SituationPromptImageBlock
	| SituationPromptPathReferenceBlock;

export interface SituationPrompt {
	readonly blocks: readonly SituationPromptBlock[];
}

/** Formats the free-text instruction with element + page grounding into one text block's contents. */
function composeInstructionText(context: ElementContext): string {
	const { element, page, instruction } = context;
	return `${instruction}\n\nElement: <${element.tagName}> ${element.selector}\nPage: ${page.url}`;
}

/**
 * Composes the capability-gated `SituationPrompt` for one element-pointing
 * dispatch (spec §6 Dispatch row, §9.4). The text instruction and the crop's
 * path reference are always present; the inline image content block is
 * included only when `capabilities.images` is true — geist "degrades per
 * capability, never per harness name" (spec §3).
 */
export function composeSituationPrompt(context: ElementContext, capabilities: HarnessCapabilities): SituationPrompt {
	const blocks: SituationPromptBlock[] = [{ type: "text", text: composeInstructionText(context) }];

	if (capabilities.images) {
		blocks.push({ type: "image", path: context.cropPath });
	}

	blocks.push({ type: "path-reference", path: context.cropPath });

	return { blocks };
}
