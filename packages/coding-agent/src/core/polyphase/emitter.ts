/**
 * Throttled partial-update emitter (§10.7): turns a run's `onFlush` notifications into
 * `AgentToolUpdateCallback` invocations, coalesced to at most once per `liveUpdateMs` (TUI) or
 * 1000 ms (every other mode), with a fast path for coarse changes so the row shows a blocked or
 * finished agent without waiting out the full throttle.
 */

import type { AgentToolUpdateCallback, ExtensionMode } from "../extensions/types.ts";
import { buildDetails } from "./details.ts";
import { formatPartialStatusText } from "./result-text.ts";
import type { PolyphaseRun } from "./store.ts";
import type { PolyphaseDetails } from "./types.ts";

export interface PartialUpdateEmitter {
	/** Emits immediately, bypassing the throttle. */
	flush(): void;
	dispose(): void;
}

export interface PartialUpdateEmitterOptions {
	mode: ExtensionMode;
	liveUpdateMs: number;
}

/** A coarse change (e.g. a tool blocked, an agent finished) emits once at least this long has
 *  passed since the last emission, rather than waiting out the full throttle interval. */
const COARSE_FAST_PATH_MS = 50;
const NON_TUI_INTERVAL_MS = 1000;

export function createPartialUpdateEmitter(
	run: PolyphaseRun,
	onUpdate: AgentToolUpdateCallback<PolyphaseDetails> | undefined,
	options: PartialUpdateEmitterOptions,
): PartialUpdateEmitter {
	if (!onUpdate) return { flush() {}, dispose() {} };
	const emit = onUpdate;

	const minIntervalMs = options.mode === "tui" ? options.liveUpdateMs : NON_TUI_INTERVAL_MS;
	let lastEmitAt = Number.NEGATIVE_INFINITY;
	let trailingTimer: ReturnType<typeof setTimeout> | undefined;
	let trailingDeadline: number | undefined;
	let disposed = false;

	function clearTrailing(): void {
		if (trailingTimer === undefined) return;
		clearTimeout(trailingTimer);
		trailingTimer = undefined;
		trailingDeadline = undefined;
	}

	function emitNow(): void {
		if (disposed) return;
		clearTrailing();
		lastEmitAt = Date.now();
		emit({
			content: [{ type: "text", text: formatPartialStatusText(run) }],
			details: buildDetails(run, { final: false }),
		});
	}

	// Re-arms the timer only when the new deadline is sooner than the one already pending, so a
	// coarse flush can shorten an existing fine deadline instead of waiting it out.
	function armTrailing(delayMs: number): void {
		const deadline = Date.now() + delayMs;
		if (trailingTimer !== undefined) {
			if (trailingDeadline !== undefined && deadline >= trailingDeadline) return;
			clearTrailing();
		}
		const timer = setTimeout(() => {
			trailingTimer = undefined;
			trailingDeadline = undefined;
			try {
				emitNow();
			} catch {
				// Partial updates are best-effort: a throw here must not escape a Node timer as an
				// uncaughtException and kill the host process.
			}
		}, delayMs);
		timer.unref?.();
		trailingTimer = timer;
		trailingDeadline = deadline;
	}

	function onRunFlush(_run: PolyphaseRun, coarse: boolean): void {
		if (disposed) return;
		const elapsed = Date.now() - lastEmitAt;
		if ((coarse && elapsed >= COARSE_FAST_PATH_MS) || elapsed >= minIntervalMs) {
			emitNow();
			return;
		}
		armTrailing((coarse ? COARSE_FAST_PATH_MS : minIntervalMs) - elapsed);
	}

	// Emit before subscribing: if the first emission throws (e.g. `onUpdate` or `buildDetails`),
	// the caller never gets a dispose handle and must not be left with a listener on `run`.
	emitNow();
	const unsubscribe = run.onFlush(onRunFlush);

	return {
		flush() {
			emitNow();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTrailing();
			unsubscribe();
		},
	};
}
