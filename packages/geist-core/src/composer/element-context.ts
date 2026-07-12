import { randomUUID } from "node:crypto";
import type { HarnessSession } from "../harness-session.js";

/**
 * Structural mirror of `geist-picker`'s `ElementDescriptor`
 * (`packages/geist-picker/src/index.ts`: `{ tagName, selector, boundingRect }`).
 *
 * `geist-core`'s package.json states it "imports no @draht/* other than
 * geist-protocol" — so this shape is mirrored by hand rather than imported,
 * the same "mirror, don't import" discipline the repo already applies across
 * the WS wire to the Kotlin side (`scripts/check-geist-mirrors.mjs`). The
 * descriptor crosses from picker → headset → bridge as plain JSON (spec
 * §9.2/§10) and lands here structurally typed.
 */
export interface ElementBoundingRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Mirrors `geist-picker`'s `ElementDescriptor` — see module doc comment above. */
export interface ElementDescriptor {
	/** Lower-cased tag name, e.g. `"button"`. */
	readonly tagName: string;
	/** A short, reasonably stable CSS selector for the element. */
	readonly selector: string;
	/** Viewport-relative bounding rect at description time. */
	readonly boundingRect: ElementBoundingRect;
}

/**
 * The panel/page the pointed element lives on — enough situational grounding
 * for the composed prompt to say "where" (spec §2: "an element in an app
 * panel").
 */
export interface ElementContextPage {
	readonly url: string;
}

/** Reuses `HarnessSession.id`'s type rather than inventing a parallel session identifier. */
export type SessionId = HarnessSession["id"];

/**
 * `ElementContext` (spec §9.3 says "unchanged (r2)" — the r2 text predates
 * this revision of the spec document and isn't reproduced there; this is the
 * concrete M2 design, grounded in what's established elsewhere: the picker's
 * element descriptor (§10), the session concept from `harness-session.ts`
 * (Phase 31), and the crop-path convention fixed by §6/§9.4).
 *
 * Fields:
 *  - `element`     — the pointed element, as described by geist-picker.
 *  - `page`         — the panel's URL the element was pointed at.
 *  - `sessionId`    — the `HarnessSession.id` of "the session owning that
 *                      panel" (spec §2) — the request's addressee.
 *  - `instruction`  — the free-text design/change request (spec §2), spoken
 *                      or typed, already transcribed upstream by M1's ASR
 *                      pipeline before it reaches the composer.
 *  - `taskId`       — generated per element-pointing dispatch; the `<id>`
 *                      segment of the crop path convention below.
 *  - `cropPath`     — the fixed convention from spec §6's Dispatch row and
 *                      §9.4: `<wt>/.geist/task-<id>/target.webp`. This module
 *                      only knows the *path*, never the image bytes — the
 *                      picker/headset pipeline (PixelCopy → frozen-target
 *                      lens, spec §13) writes the actual crop file at exactly
 *                      this path; writing it is out of scope for this phase.
 */
export interface ElementContext {
	readonly element: ElementDescriptor;
	readonly page: ElementContextPage;
	readonly sessionId: SessionId;
	readonly instruction: string;
	readonly taskId: string;
	readonly cropPath: string;
}

export interface ComposeElementContextInput {
	readonly element: ElementDescriptor;
	readonly page: ElementContextPage;
	readonly sessionId: SessionId;
	/** The user's free-text design/change request (spec §2). */
	readonly instruction: string;
	/** Absolute path to the session's worktree root — the `<wt>` in the crop path convention. */
	readonly worktreeRoot: string;
	/** Task id override, for deterministic tests. Defaults to a fresh `crypto.randomUUID()`. */
	readonly taskId?: string;
}

/**
 * Builds the fixed crop path convention (spec §6 Dispatch row, §9.4):
 * `<wt>/.geist/task-<id>/target.webp`.
 */
export function buildCropPath(worktreeRoot: string, taskId: string): string {
	return `${worktreeRoot}/.geist/task-${taskId}/target.webp`;
}

/**
 * Composes an `ElementContext` from a picker element descriptor plus the
 * session/page it was pointed at and the user's free-text request — the
 * "point at an element ... talk" half of spec §2's core loop. Generates a
 * fresh `taskId` (unless one is supplied, e.g. by a test) and derives
 * `cropPath` from it. Pure composition: no filesystem access, no image bytes
 * written or read.
 */
export function composeElementContext(input: ComposeElementContextInput): ElementContext {
	const taskId = input.taskId ?? randomUUID();
	return {
		element: input.element,
		page: input.page,
		sessionId: input.sessionId,
		instruction: input.instruction,
		taskId,
		cropPath: buildCropPath(input.worktreeRoot, taskId),
	};
}
