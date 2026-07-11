import type { HarnessSession } from "@draht/geist-core";
import type { PermissionOption, PermissionRequestMessage } from "@draht/geist-protocol";

/**
 * The `session/request_permission` relay (spec §9.2, R35-M3.5): wires a
 * live session's pending-permission events to the `permission_request` /
 * `permission_answer` WS messages `packages/geist/src/pairing/server.ts`
 * forwards to/from the paired headset.
 *
 * Scope note: this is the WS RELAY layer only — no chip rendering (console
 * is still a bare tokens-styled panel, spec §16 M1) and no voice allow/deny
 * mapping (ASR-pipeline work, later milestone). Those consume this module's
 * output; they don't live here.
 */

/** One pending permission request, already normalized to the wire shape (spec §9.2's `permission_request` payload, minus `sessionId` — the bridge adds that from the registration key). */
export interface PermissionRequestEvent {
	readonly requestId: string;
	readonly title: string;
	readonly options: readonly PermissionOption[];
}

/**
 * The slice of a live ACP session this relay needs: `HarnessSession`'s
 * `id` + `answerPermission` (the harness-agnostic port `@draht/geist-core`
 * already owns) plus a way to observe pending permission requests as they
 * appear. Declared structurally here — rather than importing
 * `AcpHarnessSession` from `@draht/geist-acp` — so this module (and its
 * tests) stay usable with a plain fake session and the relay logic doesn't
 * pull ACP wire types across the boundary the spec draws at geist-acp
 * (spec §17.1). `@draht/geist-acp`'s real `AcpHarnessSession` does NOT satisfy
 * this shape directly — an ADAPTER is required. Its `PermissionRequestEvent`
 * is ACP-flavored and the field names differ: it carries `toolCall` (an ACP
 * `ToolCallUpdate`) where this wire shape expects a plain `title`, and its
 * `options` are ACP-shaped `{ optionId, name, kind }` where this shape expects
 * `{ id, label, kind }`. Translating that ACP-flavored event into this
 * wire-flavored one is composition-root wiring for a later task, not this
 * relay.
 */
export interface PermissionRelaySession extends Pick<HarnessSession, "id" | "answerPermission"> {
	onPermissionRequest(listener: (event: PermissionRequestEvent) => void): () => void;
}

export type PermissionRequestListener = (message: PermissionRequestMessage) => void;

/**
 * Thrown by {@link SessionBridge.answerPermission} when the named session
 * isn't registered (already stopped/removed, or never was) — the pairing
 * server turns this into a `{"type":"error","reason":"permission_answer_failed"}`
 * reply rather than letting the WS handler throw.
 */
export class UnknownSessionError extends Error {
	constructor(sessionId: string) {
		super(`no registered session "${sessionId}" for permission_answer`);
		this.name = "UnknownSessionError";
	}
}

/**
 * Transport-agnostic registry sitting between live sessions and however many
 * headset connections care about them (today: one paired WS connection,
 * `pairing/server.ts`). Register a session when it starts; its
 * `permission_request` events are re-emitted as WS-shaped messages to every
 * subscriber. Route inbound `permission_answer` messages back here to
 * resolve the matching session's pending request.
 */
export class SessionBridge {
	private readonly sessions = new Map<string, { session: PermissionRelaySession; unsubscribe: () => void }>();
	private readonly listeners = new Set<PermissionRequestListener>();

	/**
	 * Starts relaying `session`'s permission requests. Throws if a session
	 * with the same `id` is already registered — a duplicate registration
	 * would silently orphan the first subscription.
	 */
	registerSession(session: PermissionRelaySession): void {
		if (this.sessions.has(session.id)) {
			throw new Error(`session "${session.id}" is already registered with the session bridge`);
		}

		const unsubscribe = session.onPermissionRequest((event) => {
			const message: PermissionRequestMessage = {
				type: "permission_request",
				payload: {
					sessionId: session.id,
					requestId: event.requestId,
					title: event.title,
					options: [...event.options],
				},
			};
			for (const listener of this.listeners) listener(message);
		});

		this.sessions.set(session.id, { session, unsubscribe });
	}

	/** Stops relaying `sessionId`'s permission requests. No-op if it isn't registered. */
	unregisterSession(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		entry.unsubscribe();
		this.sessions.delete(sessionId);
	}

	/** `true` if a session with this id is currently registered. */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** Subscribes to every registered session's `permission_request` messages, already WS-shaped. Returns an unsubscribe function. */
	onPermissionRequest(listener: PermissionRequestListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Resolves `sessionId`'s pending `requestId` with `optionId` (spec §9.2's
	 * `permission_answer` payload). Throws {@link UnknownSessionError} if the
	 * session isn't registered; propagates whatever `answerPermission` itself
	 * throws (e.g. an unknown/already-answered `requestId`) unchanged.
	 */
	async answerPermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			throw new UnknownSessionError(sessionId);
		}
		await entry.session.answerPermission(requestId, optionId);
	}
}

/** Creates a fresh, empty {@link SessionBridge}. */
export function createSessionBridge(): SessionBridge {
	return new SessionBridge();
}
