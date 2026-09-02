/**
 * ONE renderer journey — handshake, fleet row, attach, input, output, permission, detach — over a session whose
 * ORIGIN is deliberately not an option, so a suite proves R36-SPAWN.8 by running the identical call over a spawned
 * session and a resumed one.
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
 * Every key a fleet row is allowed to carry, and every key it must. A literal rather than a derivation from
 * `AttachableSessionSchema`, so that adding a key to the schema fails here until a human edits this list.
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

export class AttachJourneyError extends Error {
	override readonly name = "AttachJourneyError";
}

export interface AttachJourneyOptions {
	/** `ws://127.0.0.1:<port>`. */
	wsBase: string;
	/** Defaults to `wsBase` with `ws`→`http`. */
	httpBase?: string;
	token: string;
	sessionId: string;
	clientId?: string;
	prompt: string;
	/** Substring the streamed assistant text must contain. */
	expectOutput: string;
	/** Undefined leaves an arriving ask unanswered, for a journey whose point is the ask itself. */
	answerPermissionWith?: string;
	requirePermission?: boolean;
	capabilities?: readonly string[];
	minOutputFrames?: number;
	detach?: boolean;
	expectCwd?: string;
	timeoutMs?: number;
	clientName?: string;
}

export interface AttachJourneyResult {
	row: AttachableSession;
	/** The same row as raw JSON, before any schema stripped anything. */
	rawRow: Record<string, unknown>;
	rawSnapshotRow: Record<string, unknown>;
	pid: number;
	metadata: SessionMetadataFrame;
	/** Every `output` frame's data, concatenated in arrival order. */
	output: string;
	outputFrames: number;
	permissionRequests: PermissionRequestFrame[];
	closed: { code: number; reason: string } | null;
	frames: GeistServerFrame[];
}

/** Throws {@link AttachJourneyError} at the first step that does not hold, naming the session and the step. */
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

	// HTTP rather than the socket snapshot because it is the surface that can be polled without re-running a handshake.
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
	// The kernel's view, not the daemon's: an attachable row whose process is gone is the fleet lying.
	if (!isProcessAlive(pid)) {
		throw new AttachJourneyError(`session ${sessionId} claims pid ${pid}, which is not a running process`);
	}

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

		renderer.send({ type: "input", data: prompt, clientId });
		await until(
			() => {
				// Answered inside the same wait as the output it blocks: a session awaiting approval emits no
				// further assistant text, so answering only after the output arrived would deadlock.
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

		if (detach) {
			renderer.send({ type: "detach", clientId });
			// The bridge closes the socket itself on detach, with 1000/"detached".
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
 * Assert a RAW fleet row carries exactly the frozen key set — raw because `z.object` strips unknown keys, so the
 * parsed row can never show a spawn-only extra. `requirePid` is false for a history row, which has no process.
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
	// So that a body which is not a fleet frame fails here rather than reading as "the row is absent".
	FleetFrameSchema.parse(body);
	return (body.sessions as Record<string, unknown>[]) ?? [];
}

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
		// The fleet snapshot follows `server_hello`, so waiting for the fleet waits for both.
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

	/** Idempotent. */
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
		} catch {}
	}
}

/**
 * The probe result is AWAITED, not merely tested: an async probe returns a Promise, and a Promise is always truthy,
 * so dropping the await would make every step above succeed on its first tick.
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
