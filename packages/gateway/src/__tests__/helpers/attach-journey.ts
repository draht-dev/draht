/**
 * The whole renderer journey, ONCE, over an origin it is not allowed to know.
 *
 * R36-SPAWN.8 is the requirement that a session STARTED FROM THE PHONE is
 * indistinguishable from one the operator resumed: same fleet row, same attach,
 * same streamed output, same permission prompt, same detach. A requirement of
 * that shape cannot be proved by two suites that each hand-write their own
 * version of the journey — `fleet-attach.e2e.test.ts:329` and
 * `session-resume.e2e.test.ts:739` are exactly that today, two differently
 * worded copies which already assert different things about the same wire (one
 * checks streaming, the other checks the permission relay; neither checks the
 * row's key set). Two copies that drift are how "identical" becomes a claim
 * nobody is testing.
 *
 * So this module exports ONE script. It takes a session id, a base URL and a
 * token, and NOTHING that says where the session came from: there is no `origin`
 * option, no "if spawned" branch, and no way for a caller to relax a step for
 * one origin. A suite proves R36-SPAWN.8 by running the identical call over a
 * spawned session and over a resumed one and getting the same answers back.
 *
 * ## Why the key set is frozen here rather than left to the schema
 *
 * {@link FROZEN_ROW_KEYS} is a literal list, checked against the RAW JSON that
 * came off the wire — not against `AttachableSessionSchema`, and not against the
 * object the schema produced. Both of those would be vacuous:
 *
 *   • `z.object` STRIPS unknown keys, so a row carrying a spawn-only extra field
 *     arrives here already cleaned, and a check on the parsed value can never
 *     see it;
 *   • a check phrased as "matches the schema" passes the moment somebody adds
 *     the field to the schema, which is precisely the change the requirement
 *     exists to notice.
 *
 * A literal list fails loudly in both directions: an extra key on the wire fails
 * the raw check, and an extra key added to the schema fails this list until a
 * human edits it deliberately. The list was read off `wire.ts`'s
 * `AttachableSessionSchema` when it was written.
 *
 * `pid` is the one key allowed to be absent, and only because the schema makes
 * it optional for a reason that predates this phase: an `origin: "history"` row
 * has no process, so a required `pid` could only be satisfied by inventing one.
 * That is not a loophole — every other key is still required, and an UNEXPECTED
 * key still fails.
 */

import {
	type AttachableSession,
	AttachableSessionSchema,
	FleetFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	type PermissionRequestFrame,
	ServerFrameSchema,
	type SessionMetadataFrame,
} from "@draht/geist-protocol";
import { isProcessAlive } from "./process-table.js";

/**
 * Every key a fleet row is allowed to carry, and every key it must.
 *
 * Read off `AttachableSessionSchema` in `packages/geist-protocol/src/wire.ts`.
 * A spawn that added, say, `spawnedBy` or `harness` to its own rows would make
 * the phone's list shape depend on where a session came from, which is the one
 * thing R36-SPAWN.8 forbids.
 */
export const FROZEN_ROW_KEYS = [
	"id",
	"cwd",
	"pid",
	"startedAt",
	"origin",
	"attachable",
	"resumable",
	"status",
	"statusAt",
] as const;

/** Raised by every step of the journey, so a failure names the step it failed at. */
export class AttachJourneyError extends Error {
	override readonly name = "AttachJourneyError";
}

export interface AttachJourneyOptions {
	/** `ws://127.0.0.1:<port>` — the daemon's WebSocket base. */
	wsBase: string;
	/** Defaults to `wsBase` with `ws`→`http`. `GET /fleet` is read over it. */
	httpBase?: string;
	/** Bearer token the daemon was started with. */
	token: string;
	/** The session to travel to. Its ORIGIN is deliberately not an option. */
	sessionId: string;
	/** Distinguishes this renderer in `client_joined` / `input_echo`. */
	clientId?: string;
	/** Sent once attached. */
	prompt: string;
	/** Substring the streamed assistant text must contain. */
	expectOutput: string;
	/**
	 * Answer a `permission_request` with this option id when one arrives.
	 *
	 * `undefined` means "do not answer" — a journey that leaves an ask hanging,
	 * used when the point is the ask itself.
	 */
	answerPermissionWith?: string;
	/** Fail unless the session raised at least one `permission_request`. */
	requirePermission?: boolean;
	/** Capabilities declared in `attach` (`fleet-delta`, …). */
	capabilities?: readonly string[];
	/** Minimum number of `output` frames, so "streamed" can be asserted. Default 1. */
	minOutputFrames?: number;
	/** Send `detach` at the end and require close 1000. Default true. */
	detach?: boolean;
	/** The row's `cwd` must equal this. */
	expectCwd?: string;
	/** Budget for each waiting step. Default 60s. */
	timeoutMs?: number;
	/** Name this renderer gives in `hello`. */
	clientName?: string;
}

export interface AttachJourneyResult {
	/** The row as `GET /fleet` served it, parsed. */
	row: AttachableSession;
	/** The same row as raw JSON, before any schema stripped anything. */
	rawRow: Record<string, unknown>;
	/** The row from the WebSocket snapshot, raw. Proves both surfaces agree. */
	rawSnapshotRow: Record<string, unknown>;
	/** The live process behind the row. */
	pid: number;
	metadata: SessionMetadataFrame;
	/** Every `output` frame's data, concatenated in arrival order. */
	output: string;
	outputFrames: number;
	permissionRequests: PermissionRequestFrame[];
	/** `{ code, reason }` when the socket closed, which a detach requires. */
	closed: { code: number; reason: string } | null;
	/** Every server frame this connection received, in order. */
	frames: GeistServerFrame[];
}

/**
 * Handshake → fleet snapshot → row shape → attach → input → streamed output →
 * (permission) → detach, against whatever produced the session.
 *
 * Throws {@link AttachJourneyError} at the first step that does not hold. Every
 * message names the session id and the step, because a caller running this twice
 * over two origins needs to know which run failed.
 */
export async function attachJourney(options: AttachJourneyOptions): Promise<AttachJourneyResult> {
	const {
		wsBase,
		token,
		sessionId,
		prompt,
		expectOutput,
		clientId = "journey-client",
		clientName = "attach-journey",
		timeoutMs = 60_000,
		minOutputFrames = 1,
		detach = true,
	} = options;
	const httpBase = options.httpBase ?? wsBase.replace(/^ws/, "http");
	const authorization = { Authorization: `Bearer ${token}` };

	// ── 1. The row, over HTTP, raw ───────────────────────────────────────────
	// HTTP rather than the socket snapshot, because this is the surface that can
	// be POLLED: a session that has just been spawned or resumed reaches the
	// observer within a poll, and re-opening a WebSocket per attempt would spend
	// the handshake this journey is also asserting.
	const rawRow = await until(
		async () => (await fleetRows(httpBase, authorization, sessionId)).find((row) => row.id === sessionId),
		`session ${sessionId} to appear in GET /fleet`,
		timeoutMs,
	);
	assertFrozenRowShape(rawRow, { where: `GET /fleet row for ${sessionId}`, requirePid: true });
	const row = AttachableSessionSchema.parse(rawRow);
	if (!row.attachable) {
		throw new AttachJourneyError(`session ${sessionId} is in the fleet but attachable:false — nothing to attach to`);
	}
	// `origin` is the one FIELD VALUE this journey pins, and pinning it is the
	// point rather than an exception to "knows nothing about the origin": an
	// attachable session is a live socket whoever started it, so a spawn that
	// invented `origin: "spawn"` — or any third value — would give the phone a
	// row it has to special-case. The enum has exactly two members today
	// (`socket`, `history`) and only one of them can be attachable.
	if (row.origin !== "socket") {
		throw new AttachJourneyError(
			`session ${sessionId} is attachable with origin ${JSON.stringify(row.origin)}; a live session is a ` +
				`socket whatever started it (R36-SPAWN.8)`,
		);
	}
	if (options.expectCwd !== undefined && row.cwd !== options.expectCwd) {
		throw new AttachJourneyError(`session ${sessionId} reports cwd ${row.cwd}, expected ${options.expectCwd}`);
	}
	const pid = row.pid;
	if (pid === undefined) {
		throw new AttachJourneyError(`session ${sessionId} is attachable and carries no pid`);
	}
	// The kernel's view, not the daemon's: an attachable row whose process is
	// gone (or defunct) is the fleet lying, and every later assertion in this
	// journey would then be about a session that does not exist.
	if (!isProcessAlive(pid)) {
		throw new AttachJourneyError(`session ${sessionId} claims pid ${pid}, which is not a running process`);
	}

	// ── 2. Handshake, and the same row on the socket ─────────────────────────
	const renderer = await JourneyRenderer.open(`${wsBase}/attach`, token);
	try {
		const hello = await renderer.hello(clientName, timeoutMs);
		if (hello.protocol !== GEIST_PROTOCOL_FAMILY || hello.version !== GEIST_PROTOCOL_VERSION) {
			throw new AttachJourneyError(
				`server_hello announced ${String(hello.protocol)}/${String(hello.version)}, expected ` +
					`${GEIST_PROTOCOL_FAMILY}/${GEIST_PROTOCOL_VERSION}`,
			);
		}
		const rawSnapshotRow = renderer.rawFleetRow(sessionId);
		if (rawSnapshotRow === undefined) {
			throw new AttachJourneyError(
				`the fleet snapshot on this connection has no row for ${sessionId}, although GET /fleet does`,
			);
		}
		assertFrozenRowShape(rawSnapshotRow, { where: `fleet snapshot row for ${sessionId}`, requirePid: true });

		// ── 3. Attach ────────────────────────────────────────────────────────
		renderer.send({
			type: "attach",
			sessionId,
			clientId,
			mode: "read-write",
			...(options.capabilities === undefined ? {} : { capabilities: [...options.capabilities] }),
		});
		const metadataFrame = await renderer.waitFor(
			(frame) => frame.type === "session_metadata",
			`session_metadata for ${sessionId}`,
			timeoutMs,
		);
		if (metadataFrame.type !== "session_metadata") throw new AttachJourneyError("unreachable: frame narrowing");
		if (metadataFrame.sessionId !== sessionId) {
			throw new AttachJourneyError(
				`attached to ${sessionId} and was answered metadata for ${metadataFrame.sessionId}`,
			);
		}

		// ── 4. Type, and read what comes back ────────────────────────────────
		renderer.send({ type: "input", data: prompt, clientId });
		await until(
			() => {
				// Answered inside the same wait as the output it is blocking: a tool
				// call that needs approval produces NO further assistant text until
				// somebody answers, so a journey that waited for output first and
				// looked for the ask afterwards would time out on every session that
				// asks for anything.
				if (options.answerPermissionWith !== undefined) {
					renderer.answerPendingPermissions(clientId, options.answerPermissionWith);
				}
				return renderer.output().includes(expectOutput);
			},
			() =>
				`the assistant text to contain ${JSON.stringify(expectOutput)} for ${sessionId} ` +
				`(saw ${JSON.stringify(renderer.output().slice(-400))})`,
			timeoutMs,
		);
		const outputFrames = renderer.frames.filter((frame) => frame.type === "output").length;
		if (outputFrames < minOutputFrames) {
			throw new AttachJourneyError(
				`the reply arrived in ${outputFrames} output frame(s), fewer than the ${minOutputFrames} required`,
			);
		}
		if (options.requirePermission === true && renderer.permissionRequests().length === 0) {
			throw new AttachJourneyError(`session ${sessionId} never raised a permission_request`);
		}

		// ── 5. Detach ────────────────────────────────────────────────────────
		if (detach) {
			renderer.send({ type: "detach", clientId });
			// The bridge closes the socket on detach with 1000/"detached". Waiting
			// for the close rather than assuming it is what makes this a round trip.
			await until(() => renderer.closed !== null, `the socket to close after detach on ${sessionId}`, timeoutMs);
			if (renderer.closed?.code !== 1000) {
				throw new AttachJourneyError(
					`detach closed with ${renderer.closed?.code} ${JSON.stringify(renderer.closed?.reason)}, expected 1000`,
				);
			}
		}

		return {
			row,
			rawRow,
			rawSnapshotRow,
			pid,
			metadata: metadataFrame,
			output: renderer.output(),
			outputFrames,
			permissionRequests: renderer.permissionRequests(),
			closed: renderer.closed,
			frames: renderer.frames,
		};
	} finally {
		renderer.close();
	}
}

/**
 * Assert a raw fleet row carries exactly the frozen key set.
 *
 * Exported on its own because a suite may want the check on a row it obtained
 * some other way — a `fleet_delta` body, a snapshot taken before it attached.
 * `requirePid` is the caller's statement about which kind of row this is: a live
 * row must have one, a history row must not be forced to invent one.
 */
export function assertFrozenRowShape(
	raw: Record<string, unknown>,
	options: { where: string; requirePid: boolean },
): void {
	const present = Object.keys(raw).sort();
	const allowed = new Set<string>(FROZEN_ROW_KEYS);
	const unexpected = present.filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new AttachJourneyError(
			`${options.where} carries key(s) no fleet row may carry: ${unexpected.join(", ")}. ` +
				`A row's shape must not depend on where the session came from (R36-SPAWN.8). Saw: ${present.join(", ")}`,
		);
	}
	const missing = FROZEN_ROW_KEYS.filter((key) => !(key in raw) && (key !== "pid" || options.requirePid));
	if (missing.length > 0) {
		throw new AttachJourneyError(
			`${options.where} is missing required key(s): ${missing.join(", ")}. Saw: ${present.join(", ")}`,
		);
	}
}

/** `GET /fleet`, kept as raw JSON so nothing strips a field before it is checked. */
async function fleetRows(
	httpBase: string,
	headers: Record<string, string>,
	sessionId: string,
): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${httpBase}/fleet`, { headers });
	if (!response.ok) {
		throw new AttachJourneyError(`GET /fleet answered ${response.status} while looking for ${sessionId}`);
	}
	const body = (await response.json()) as { sessions?: unknown };
	// Parsed as well as read raw: a body that is not a fleet frame at all must
	// fail here rather than produce "the row is absent".
	FleetFrameSchema.parse(body);
	return (body.sessions as Record<string, unknown>[]) ?? [];
}

/** One renderer, driven exactly as a phone would drive it. */
class JourneyRenderer {
	readonly frames: GeistServerFrame[] = [];
	/** The same frames before validation, so a raw row survives schema stripping. */
	readonly raw: Record<string, unknown>[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;
	readonly #answered = new Set<string>();

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
			this.raw.push(parsed);
			// Re-validated on arrival: nothing the daemon emits is trusted here any
			// more than a renderer's bytes are trusted there.
			this.frames.push(ServerFrameSchema.parse(parsed));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(url: string, token: string): Promise<JourneyRenderer> {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(url, { headers: { Authorization: `Bearer ${token}` } });
		const renderer = new JourneyRenderer(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new AttachJourneyError(`the daemon refused a socket at ${url}`)));
		});
		return renderer;
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	async hello(clientName: string, timeoutMs: number): Promise<Extract<GeistServerFrame, { type: "server_hello" }>> {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: clientName, version: "0.0.0" },
		});
		// The fleet snapshot follows `server_hello` on an authenticated
		// connection, so waiting for the fleet waits for both.
		await this.waitFor((frame) => frame.type === "fleet", "the fleet snapshot", timeoutMs);
		const hello = this.frames.find((frame) => frame.type === "server_hello");
		if (hello === undefined || hello.type !== "server_hello") {
			throw new AttachJourneyError("the daemon sent a fleet snapshot without a server_hello");
		}
		return hello;
	}

	/** The row as it arrived, before `ServerFrameSchema` stripped anything. */
	rawFleetRow(sessionId: string): Record<string, unknown> | undefined {
		for (const frame of this.raw) {
			if (frame.type !== "fleet") continue;
			const sessions = (frame.sessions as Record<string, unknown>[]) ?? [];
			const row = sessions.find((session) => session.id === sessionId);
			if (row) return row;
		}
		return undefined;
	}

	permissionRequests(): PermissionRequestFrame[] {
		return this.frames.filter((frame): frame is PermissionRequestFrame => frame.type === "permission_request");
	}

	/** Answer every ask this connection has not already answered. Idempotent. */
	answerPendingPermissions(clientId: string, optionId: string): void {
		for (const ask of this.permissionRequests()) {
			if (this.#answered.has(ask.requestId)) continue;
			this.#answered.add(ask.requestId);
			this.send({ type: "permission_response", clientId, requestId: ask.requestId, optionId });
		}
	}

	output(): string {
		return this.frames
			.filter((frame): frame is Extract<GeistServerFrame, { type: "output" }> => frame.type === "output")
			.map((frame) => frame.data)
			.join("");
	}

	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs: number,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			() => `${what} (saw: ${this.frames.map((frame) => frame.type).join(", ")})`,
			timeoutMs,
		);
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

/**
 * Poll until `probe` yields something truthy.
 *
 * The result is AWAITED, not merely tested: an async probe returns a Promise and
 * a Promise is always truthy, so a version of this that skipped the await would
 * succeed on the first tick of every step above. `what` may be a thunk so a
 * message that quotes something still being written reports what it held when
 * the wait gave up rather than when it started.
 */
async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string | (() => string),
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value as T;
		if (Date.now() >= deadline) {
			throw new AttachJourneyError(
				`timed out after ${timeoutMs} ms waiting for ${typeof what === "function" ? what() : what}`,
			);
		}
		await Bun.sleep(50);
	}
}
