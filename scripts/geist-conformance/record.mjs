/**
 * Records the geist attach wire off a running daemon (R32-FLEET.5).
 *
 * Nothing in the conformance corpus is written by hand. This module spawns two
 * real processes — a real draht `SocketServer` and the geist reference daemon —
 * drives real WebSocket clients against the daemon's real loopback listener,
 * and returns exactly the frames that crossed the wire.
 *
 * Determinism, so that byte-equality is a meaningful gate:
 *   - every step awaits the specific frame it expects before the next step
 *     runs, and a frame is appended to the transcript at the moment it is
 *     awaited (not at the moment it arrives), so the transcript order is the
 *     recorder's script order rather than a race between clients;
 *   - client ids, the session id, the session's reported cwd and the bootstrap
 *     tokens are fixed;
 *   - the values that cannot be fixed — the daemon's real pid, the real
 *     creation timestamps, and the randomly generated device credentials with
 *     their issue/expiry instants — are normalized against NORMALIZED_FIELDS
 *     below and that substitution is declared in every golden file it touched.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TRANSPORT_LIMITS, GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "../../packages/geist-protocol/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

const SESSION_ID = "conformance";
/**
 * A second, short-lived session started and stopped solely so the fleet REALLY
 * changes under the daemon's feet. The `fleet_delta` goldens are the diff of two
 * observations of a real directory — nothing pushes a fabricated change.
 */
const TRANSIENT_SESSION_ID = "conformance-transient";
/** The id the reference daemon models as history. It has no socket, by construction. */
const HISTORY_SESSION_ID = "conformance-history";
/** Reported as the session's cwd. A literal, so no machine path reaches the corpus. */
const SESSION_CWD = "/geist/conformance";
const BEARER_TOKEN = "conformance-bearer-token";
/**
 * The single-use bootstrap tokens handed to the daemon, one per device the
 * script pairs plus one that is deliberately spent and then replayed by the
 * rejection battery. Fixed strings: the recording has to be reproducible, and
 * these are a reference daemon's, never a real deployment's.
 */
const BOOTSTRAP_TOKENS = {
	a: "conformance-bootstrap-a",
	b: "conformance-bootstrap-b",
	c: "conformance-bootstrap-c",
	d: "conformance-bootstrap-d",
};
const READY_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 10_000;

/**
 * The only values a recording cannot hold fixed, and what each becomes. Declared
 * here and echoed into every golden that carries one, so a reader can tell a
 * substituted field from a recorded one without diffing two runs.
 */
export const NORMALIZED_FIELDS = {
	pid: 1,
	startedAt: "1970-01-01T00:00:00.000Z",
	createdAt: "1970-01-01T00:00:00.000Z",
	/**
	 * Device credentials are random by construction and must stay that way — a
	 * credential the daemon could hold fixed for a recording would be a
	 * credential an attacker could predict. They are substituted here rather
	 * than weakened at the source, which also means no bearer value, not even a
	 * reference daemon's, is committed to this repository (R33-REACH.3).
	 */
	credential: "<normalized-credential>",
	issuedAt: "1970-01-01T00:00:00.000Z",
	expiresAt: "1970-01-08T00:00:00.000Z",
};

function normalize(value) {
	if (Array.isArray(value)) return value.map(normalize);
	if (value === null || typeof value !== "object") return value;
	const out = {};
	for (const [key, inner] of Object.entries(value)) {
		out[key] = key in NORMALIZED_FIELDS ? NORMALIZED_FIELDS[key] : normalize(inner);
	}
	return out;
}

/** Which fields of a frame the normalization table actually replaced. */
function normalizedKeysOf(value, found = new Set()) {
	if (Array.isArray(value)) {
		for (const item of value) normalizedKeysOf(item, found);
		return found;
	}
	if (value === null || typeof value !== "object") return found;
	for (const [key, inner] of Object.entries(value)) {
		if (key in NORMALIZED_FIELDS) found.add(key);
		else normalizedKeysOf(inner, found);
	}
	return found;
}

/**
 * Race a promise against a timeout and always clear the timer. Clearing matters
 * beyond tidiness: a pending timer keeps the recorder's event loop alive, and a
 * gate that takes twenty seconds to exit after finishing its work in a tenth of
 * a second is a gate people start skipping.
 */
function withDeadline(promise, ms, what) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Spawn a daemon and resolve its one-line JSON readiness banner. */
async function spawnDaemon(scriptRelativePath, args) {
	const child = spawn("bun", [join(ROOT, scriptRelativePath), ...args], {
		cwd: ROOT,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const ready = new Promise((resolveReady, rejectReady) => {
		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const line = buffer.split("\n")[0];
			if (buffer.includes("\n")) resolveReady(JSON.parse(line));
		});
		child.on("exit", (code) => rejectReady(new Error(`${scriptRelativePath} exited with ${code} before readiness:\n${stderr}`)));
	});
	const banner = await withDeadline(ready, READY_TIMEOUT_MS, `${scriptRelativePath} readiness`);
	return { child, banner };
}

/**
 * One recorded WebSocket client. Frames arrive into a queue and are moved into
 * the shared transcript only when the script asks for them, which is what makes
 * the transcript order reproducible across runs and machines.
 */
class RecordedClient {
	constructor(name, url, transcript) {
		this.name = name;
		this.transcript = transcript;
		this.queue = [];
		this.waiters = [];
		this.closed = null;
		this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${BEARER_TOKEN}` } });
		this.socket.addEventListener("message", (event) => {
			this.queue.push(JSON.parse(String(event.data)));
			const waiter = this.waiters.shift();
			if (waiter) waiter();
		});
		this.socket.addEventListener("close", (event) => {
			this.closed = { code: event.code, reason: event.reason };
			for (const waiter of this.waiters.splice(0)) waiter();
		});
	}

	async open() {
		if (this.socket.readyState === 1) return;
		await withDeadline(
			new Promise((resolveOpen, rejectOpen) => {
				this.socket.addEventListener("open", () => resolveOpen());
				this.socket.addEventListener("error", () => rejectOpen(new Error(`${this.name} failed to connect`)));
			}),
			READY_TIMEOUT_MS,
			`${this.name} to connect`,
		);
	}

	/** Send a client frame and record it in the client→server direction. */
	send(frame) {
		this.transcript.push({ direction: "client-to-server", client: this.name, frame: normalize(frame) });
		this.socket.send(JSON.stringify(frame));
	}

	/** Send bytes that are not a valid frame — used only by the rejection battery. */
	sendRaw(raw) {
		this.socket.send(raw);
	}

	async next() {
		while (this.queue.length === 0) {
			if (this.closed) throw new Error(`${this.name} closed (${this.closed.code}) while a frame was expected`);
			await withDeadline(new Promise((r) => this.waiters.push(r)), FRAME_TIMEOUT_MS, `a frame for ${this.name}`);
		}
		return this.queue.shift();
	}

	/** Await the next server frame, assert its type, and record it. */
	async expect(type) {
		const frame = await this.next();
		if (frame.type !== type) {
			throw new Error(`${this.name} expected ${type}, got ${frame.type}: ${JSON.stringify(frame)}`);
		}
		this.transcript.push({ direction: "server-to-client", client: this.name, frame: normalize(frame) });
		return frame;
	}

	/** Await the next server frame WITHOUT recording it — for liveness assertions. */
	async peekType() {
		return (await this.next()).type;
	}

	async waitClosed() {
		if (this.closed) return this.closed;
		await withDeadline(
			new Promise((r) => this.socket.addEventListener("close", () => r())),
			FRAME_TIMEOUT_MS,
			`${this.name} to be closed by the daemon`,
		);
		return this.closed;
	}

	close() {
		try {
			this.socket.close();
		} catch {
			// Already gone.
		}
	}
}

/**
 * Bytes that no exported schema validates, and the code the daemon must answer
 * with. This is the executable half of "the daemon accepts a frame no exported
 * schema validates" (R32-FLEET.4): every entry is replayed against the running
 * daemon on its own connection, and the daemon has to refuse each one and drop
 * only that connection.
 */
export const REJECTED_FRAMES = [
	{ name: "not-json", handshake: false, raw: "{not json", expect: "invalid_frame" },
	{ name: "json-array", handshake: false, raw: "[]", expect: "invalid_frame" },
	{ name: "no-discriminator", handshake: false, raw: JSON.stringify({ hello: true }), expect: "unknown_type" },
	{
		name: "arbitrary-command-spawn",
		handshake: true,
		raw: JSON.stringify({ type: "spawn", command: ["/bin/sh", "-c", "touch $CANARY"] }),
		expect: "unknown_type",
	},
	{
		name: "server-frame-in-client-direction",
		handshake: true,
		raw: JSON.stringify({ type: "output", data: "x", stream: "stdout" }),
		expect: "unknown_type",
	},
	{
		name: "attach-missing-fields",
		handshake: true,
		raw: JSON.stringify({ type: "attach", sessionId: SESSION_ID }),
		expect: "invalid_frame",
	},
	{
		name: "attach-undeclared-mode",
		handshake: true,
		raw: JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "client-x", mode: "root" }),
		expect: "invalid_frame",
	},
	{
		name: "hello-foreign-protocol",
		handshake: false,
		raw: JSON.stringify({
			type: "hello",
			protocol: "acp/1.0",
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "impostor", version: "0.0.0" },
		}),
		expect: "version_mismatch",
	},
	{
		name: "attach-before-hello",
		handshake: false,
		raw: JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "client-x", mode: "read-write" }),
		expect: "handshake_required",
	},
	{
		// `fleet_resync` is post-authentication, exactly like `attach`. It decodes —
		// it is a declared 0.4 client frame — so this is the auth gate refusing it.
		name: "fleet-resync-before-auth",
		handshake: true,
		raw: JSON.stringify({ type: "fleet_resync" }),
		expect: "not_authenticated",
	},
	{
		// The reason `session_resume` carries an id and nothing else: the only thing a
		// caller can name is a session. Here it names one AND has not authenticated,
		// and the argv-shaped fields it tried to smuggle are dropped by the decoder
		// before the auth gate is even reached.
		name: "session-resume-before-auth",
		handshake: true,
		raw: JSON.stringify({ type: "session_resume", sessionId: SESSION_ID, command: ["/bin/sh", "-c", "touch $CANARY"] }),
		expect: "not_authenticated",
	},
	{
		// The reason `session_spawn` carries two registry ids and nothing else. Here
		// it names them AND has not authenticated, and the argv-shaped field it tried
		// to smuggle is dropped by the decoder before the auth gate is even reached.
		name: "session-spawn-before-auth",
		handshake: true,
		raw: JSON.stringify({
			type: "session_spawn",
			harnessId: "draht",
			projectId: "fr3n",
			command: ["/bin/sh", "-c", "touch $CANARY"],
		}),
		expect: "not_authenticated",
	},
	{
		// `registry_resync` is post-authentication for the same reason: the registry names every harness and
		// project the operator declared, and an unauthenticated connection has earned none of that list. The
		// filter smuggled here is dropped by the decoder — the frame declares no fields at all — so what the
		// daemon answers is the auth gate and not a validation accident.
		name: "registry-resync-before-auth",
		handshake: true,
		raw: JSON.stringify({ type: "registry_resync", harnessId: "draht" }),
		expect: "not_authenticated",
	},
	{
		// A perfectly valid `attach` that has simply not earned one: the device
		// exchange never happened on this connection (R33-REACH.5). The frame
		// decodes, so this is the auth gate refusing it, not the decoder.
		name: "attach-before-auth",
		handshake: true,
		raw: JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "client-x", mode: "read-write" }),
		expect: "not_authenticated",
	},
	{
		// The bootstrap token client-a already spent in step 2, presented again on
		// a fresh socket. Single-use means the second presentation buys nothing —
		// and the recorder asserts immediately afterwards that client-a, bound by
		// the first exchange, is still streaming (R33-REACH.7).
		name: "replayed-bootstrap",
		handshake: true,
		raw: JSON.stringify({
			type: "pair_device",
			bootstrapToken: BOOTSTRAP_TOKENS.a,
			device: { name: "replay", platform: "linux" },
		}),
		expect: "not_authenticated",
	},
];

const HELLO_FRAME = {
	type: "hello",
	protocol: GEIST_PROTOCOL_FAMILY,
	version: GEIST_PROTOCOL_VERSION,
	client: { name: "geist-conformance-recorder", version: "0.1.0" },
};

/**
 * Drive both daemons through one scripted session and return the recording.
 *
 * The script is chosen so that every declared message type in both directions
 * is produced by the daemon under its real conditions: a read-only client
 * really is refused by the draht session (`error`), a second client really does
 * see the first's echo (`input_echo`), an oversized frame really does drop only
 * its own connection (`protocol_error`).
 */
/**
 * A `fleet_delta` is BROADCAST to every connection that completed the device
 * exchange, so the connections the script is not asserting on must still be read
 * or their queues desynchronize the next `expect`. Drained rather than recorded:
 * the transcript's order is the script's order, and four copies of one frame in
 * it would say the daemon sent four different frames.
 *
 * It reads PAST whatever else is queued rather than demanding the delta be next.
 * Those connections have a genuine backlog — client-b was attached while client-c
 * joined, so it holds a `client_joined` the script never asserted on — and the
 * point here is only that the broadcast reached every ready connection, not that
 * it overtook their relay traffic. Bounded so a daemon that never sends it fails
 * instead of hanging.
 */
async function drainDelta(clients, budget = 16) {
	for (const client of clients) {
		let seen = 0;
		let frame = await client.next();
		while (frame.type !== "fleet_delta") {
			if (++seen > budget) {
				throw new Error(`${client.name} was never sent the broadcast fleet_delta (read ${seen} other frames)`);
			}
			frame = await client.next();
		}
	}
}

export async function recordCorpus() {
	const socketDir = await mkdtemp(join(tmpdir(), "geist-conformance-"));
	let socketDaemon;
	let referenceDaemon;
	/** The short-lived second session of step 9c. Killed in `finally` even if the script throws. */
	let transientDaemon;
	const transcript = [];
	const clients = [];

	try {
		socketDaemon = await spawnDaemon("scripts/geist-conformance/socket-daemon.mjs", [
			"--socket-dir",
			socketDir,
			"--session-id",
			SESSION_ID,
			"--cwd",
			SESSION_CWD,
		]);
		referenceDaemon = await spawnDaemon("scripts/geist-conformance/reference-daemon.mjs", [
			"--socket-dir",
			socketDir,
			"--token",
			BEARER_TOKEN,
			"--bootstrap",
			Object.values(BOOTSTRAP_TOKENS).join(","),
		]);
		const url = `ws://127.0.0.1:${referenceDaemon.banner.port}/attach`;

		const connect = async (name) => {
			const client = new RecordedClient(name, url, transcript);
			clients.push(client);
			await client.open();
			return client;
		};

		/**
		 * Handshake, then spend a bootstrap token for a real rotated credential.
		 * Returns the issued `{ deviceId, credential }` so a later step can
		 * reconnect with it — the recorder holds the real value in memory and the
		 * transcript keeps only the normalized substitute.
		 */
		const pair = async (client, bootstrapToken, device) => {
			client.send(HELLO_FRAME);
			await client.expect("server_hello");
			client.send({ type: "pair_device", bootstrapToken, device });
			const issued = await client.expect("device_credential");
			return { deviceId: issued.deviceId, credential: issued.credential };
		};

		// 1. Handshake and pair, then the fleet the daemon really discovered on
		//    disk — which arrives only after the exchange, because nothing about
		//    the fleet reaches a socket that has not completed it.
		const a = await connect("client-a");
		const deviceA = await pair(a, BOOTSTRAP_TOKENS.a, { name: "conformance-a", platform: "linux" });
		const fleet = await a.expect("fleet");
		// The 0.4 projection is two rows of two different kinds, and the corpus needs
		// both: the LIVE one is real (a real socket, a real pid), the HISTORY one is
		// the reference daemon's one modelled row — see its header. Asserting the
		// discriminating fields here is what stops a regeneration quietly recording
		// two rows of the same kind.
		//
		// ── THESE HAND-WRITTEN `throw`s ARE THE GUARD ────────────────────────────
		// Read the corpus honestly: for every daemon property this file does not
		// explicitly throw on, the golden is a SELF-COMPUTED EXPECTATION. "The corpus
		// matches the running daemon" then means only "the daemon is deterministic",
		// never "the daemon is right" — regenerate after changing the daemon and the
		// goldens follow the change without a word of protest. The assertions below
		// are the only place a wrong-but-stable answer dies, so a property that
		// matters belongs on this list rather than in a comment.
		const live = fleet.sessions.find((session) => session.id === SESSION_ID);
		const history = fleet.sessions.find((session) => session.id === HISTORY_SESSION_ID);
		if (!live || live.origin !== "socket" || live.attachable !== true || typeof live.pid !== "number") {
			throw new Error(`fleet did not report the running session as an attachable socket row: ${JSON.stringify(fleet)}`);
		}
		if (!history || history.origin !== "history" || history.attachable !== false) {
			throw new Error(`fleet did not report a non-attachable history row: ${JSON.stringify(fleet)}`);
		}
		// The two verbs, pinned per kind and in BOTH polarities, because `attachable`
		// and `resumable` are what a renderer turns into buttons:
		//
		//   live    ⇒ attachable: true,  resumable: false   → offer ATTACH
		//   history ⇒ attachable: false, resumable: true    → offer RESUME
		//
		// A live row is NOT resumable, and that is the ruling, not a stop-gap: resuming
		// a live session would start a second process appending to one session JSONL —
		// the hazard the busy lock exists for — so a renderer showing "Resume" beside a
		// live session is offering the wrong action. `session_resume` on a live id is
		// still refused `already_live` (asserted at step 9b-i), but refusal is defence
		// in depth and must not be the only thing standing between a user and it.
		//
		// Asserted here because the schema cannot: `attachable` and `resumable` are two
		// independent booleans on purpose (a live socket whose session file was deleted
		// is attachable and not resumable), so every combination parses and only a
		// recorded projection can say which one this daemon produces.
		if (live.resumable !== false) {
			throw new Error(`a LIVE row claimed to be resumable — the verb for a live session is attach: ${JSON.stringify(live)}`);
		}
		if (history.resumable !== true) {
			throw new Error(`a HISTORY row claimed not to be resumable — resume is the only verb it has: ${JSON.stringify(history)}`);
		}
		if ("pid" in history) throw new Error(`a history row invented a pid: ${JSON.stringify(history)}`);
		if (typeof fleet.epoch !== "string" || !Number.isInteger(fleet.seq)) {
			throw new Error(`the fleet snapshot is not orderable — no epoch/seq: ${JSON.stringify(fleet)}`);
		}

		// 2. Attach — the daemon dials the real .sock and relays its metadata.
		a.send({ type: "attach", sessionId: SESSION_ID, clientId: "client-a", mode: "read-write" });
		await a.expect("session_metadata");

		// 3. Real session output, relayed.
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "output", data: "geist conformance corpus\n", stream: "stdout" })}\n`);
		await a.expect("output");

		// 4. A second attached client — client-a sees it join.
		const b = await connect("client-b");
		await pair(b, BOOTSTRAP_TOKENS.b, { name: "conformance-b", platform: "ios" });
		await b.expect("fleet");
		b.send({ type: "attach", sessionId: SESSION_ID, clientId: "client-b", mode: "read-write" });
		await b.expect("session_metadata");
		await a.expect("client_joined");

		// 5. client-b types; client-a sees the echo.
		b.send({ type: "input", data: "ship it\n", clientId: "client-b" });
		await a.expect("input_echo");

		// 6. A read-only client types and the draht session refuses it — `error`
		//    is the session's refusal, relayed, not the daemon's.
		const c = await connect("client-c");
		await pair(c, BOOTSTRAP_TOKENS.c, { name: "conformance-c", platform: "android" });
		await c.expect("fleet");
		c.send({ type: "attach", sessionId: SESSION_ID, clientId: "client-c", mode: "read-only" });
		await c.expect("session_metadata");
		await a.expect("client_joined");
		c.send({ type: "input", data: "let me in\n", clientId: "client-c" });
		await c.expect("error");

		// 7. client-b leaves; client-a sees it.
		b.send({ type: "detach", clientId: "client-b" });
		await a.expect("client_left");

		// 7a. The permission arm, end to end (R34-PERM.1). The session raises a
		//     fixed ask; only client-a sees it, because client-c is read-only and
		//     the socket wire never asks a client that could not answer. client-a
		//     answers by naming an option id it was actually offered, the session
		//     routes that answer through its `onPermissionResponse` hook, and the
		//     resolution is broadcast back. Three goldens, all recorded, none
		//     authored, and nothing normalized: every field of the ask is a fixed
		//     literal in the socket daemon.
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "permission_request" })}\n`);
		const ask = await a.expect("permission_request");
		if (!ask.options.some((option) => option.id === "approve")) {
			throw new Error(`the recorded ask offered no "approve" option: ${JSON.stringify(ask)}`);
		}

		// 7a-i. THE NEUTRAL MEMBER, recorded before the approval so the golden for
		//       `permission_resolved` is the case that had no true word until 0.4. A
		//       `select` carrying a `tool_permission` detail is answered on the
		//       session's LOCAL surface; the remote copies come down and the ending is
		//       stated as `answered` — not `cancelled` (the ask WAS answered and its
		//       command ran) and not `approved` (nobody granted anything). This is the
		//       Phase 34 debt, closed on the wire, recorded rather than described.
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "permission_select" })}\n`);
		const selectAsk = await a.expect("permission_request");
		if (selectAsk.method !== "select" || selectAsk.options.some((option) => option.id === "approve")) {
			throw new Error(`the select ask carried a permission vocabulary it should not have: ${JSON.stringify(selectAsk)}`);
		}
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "permission_answered" })}\n`);
		const answered = await a.expect("permission_resolved");
		if (answered.decision !== "answered" || answered.requestId !== selectAsk.requestId) {
			throw new Error(`the local answer was not recorded as answered: ${JSON.stringify(answered)}`);
		}
		if (answered.chosenOptionId !== "opt-next") {
			throw new Error(`an answered select lost the choice that was made: ${JSON.stringify(answered)}`);
		}

		// 7a-ii. …and the confirm, answered REMOTELY, still resolves `approved`. The
		//        neutral member did not soften a real grant: `approved` still means a
		//        vocabulary that declares permission was chosen by a client.
		a.send({ type: "permission_response", clientId: "client-a", requestId: ask.requestId, optionId: "approve" });
		const resolved = await a.expect("permission_resolved");
		if (resolved.decision !== "approved" || resolved.chosenOptionId !== "approve") {
			throw new Error(`the answer did not decide the ask: ${JSON.stringify(resolved)}`);
		}

		// 7b. device-a comes back on a fresh socket and authenticates with the
		//     credential it was issued in step 1. The daemon answers with a
		//     ROTATED value, so the credential just presented is already dead —
		//     this is `authenticate` recorded under its real conditions, not
		//     described (R33-REACH.5).
		const reconnect = await connect("client-a-reconnect");
		reconnect.send(HELLO_FRAME);
		await reconnect.expect("server_hello");
		reconnect.send({ type: "authenticate", deviceId: deviceA.deviceId, credential: deviceA.credential });
		const rotated = await reconnect.expect("device_credential");
		if (rotated.credential === deviceA.credential) {
			throw new Error("authenticate returned the same credential — it was not rotated");
		}
		await reconnect.expect("fleet");

		// 8. An oversized frame: a typed refusal on the offending connection only.
		//    Refused on size before anything else, so it never reaches the auth gate.
		const d = await connect("client-d");
		d.send(HELLO_FRAME);
		await d.expect("server_hello");
		d.sendRaw(
			JSON.stringify({ type: "input", clientId: "client-d", data: "x".repeat(DEFAULT_TRANSPORT_LIMITS.maxFrameBytes) }),
		);
		await d.expect("protocol_error");
		await d.waitClosed();

		// 9. …and the other client's stream is untouched by it.
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "output", data: "still streaming\n", stream: "stdout" })}\n`);
		if ((await a.peekType()) !== "output") throw new Error("client-a's stream did not survive client-d's refusal");

		// 9a-pre. A rescan with NOTHING changed must send NOTHING. This is the whole of
		//     "it never fabricates a change", and it is asserted rather than described
		//     because a daemon that emitted an empty or invented delta on every tick
		//     would pass every other assertion in this file. Nothing has moved on disk
		//     since the snapshot client-a-reconnect took, so a delta here is fabricated.
		//
		//     Caught in BOTH orderings, because two processes have no ordering contract:
		//     if the daemon handles this stdin line before the `fleet_resync` below, a
		//     fabricated delta arrives first and `expect("fleet")` sees it; if it handles
		//     the frame first, the fabrication lands next and 9b's
		//     `expect("session_resumed")` sees it. There is no third order.
		referenceDaemon.child.stdin.write("rescan\n");

		// 9a. `fleet_resync` — the post-authentication verb, answered with a fresh
		//     snapshot on the SAME connection. It exists because neither alternative
		//     spelling survives: a repeated `hello` is refused `invalid_frame` and an
		//     undeclared type is refused `unknown_type`, and both close the connection.
		//     The snapshot's `seq` must have advanced past the one client-a first saw,
		//     or a renderer cannot order the resync against the deltas it replaces.
		a.send({ type: "fleet_resync" });
		const resynced = await a.expect("fleet");
		if (resynced.epoch !== fleet.epoch || !(resynced.seq > fleet.seq)) {
			throw new Error(`the resync snapshot is not orderable after the first: ${JSON.stringify(resynced)}`);
		}

		// 9b. `session_resume`, twice, on the two verdicts this daemon can honestly
		//     reach. The `resumed` path needs a spawn surface the reference daemon
		//     deliberately does not have (see its header), so it is the shipped
		//     daemon's Class-3 acceptance and not a corpus golden.
		a.send({ type: "session_resume", sessionId: HISTORY_SESSION_ID });
		const refusedResume = await a.expect("session_resumed");
		if (refusedResume.ok !== false || refusedResume.code !== "refused" || refusedResume.sessionId !== HISTORY_SESSION_ID) {
			throw new Error(`resume of the history row was not refused honestly: ${JSON.stringify(refusedResume)}`);
		}
		a.send({ type: "session_resume", sessionId: "no-such-session" });
		const unknownResume = await a.expect("session_resumed");
		if (unknownResume.code !== "not_found") {
			throw new Error(`resume of an unknown id was not not_found: ${JSON.stringify(unknownResume)}`);
		}

		// 9b-i. …and the third honest verdict: a LIVE id is refused `already_live`.
		//     The fleet projection already tells a renderer not to offer resume on a
		//     live row (`resumable: false`, asserted in step 1), and this is the other
		//     half of that one decision: the daemon refuses the frame anyway, so a
		//     renderer that ignores the flag — or an older one that never read it —
		//     still cannot put a second writer on one session JSONL. Recorded rather
		//     than described, because "we refuse it" is exactly the kind of claim that
		//     survives the code that made it true being deleted.
		a.send({ type: "session_resume", sessionId: SESSION_ID });
		const liveResume = await a.expect("session_resumed");
		if (liveResume.ok !== false || liveResume.code !== "already_live" || liveResume.sessionId !== SESSION_ID) {
			throw new Error(`resume of a LIVE session was not refused already_live: ${JSON.stringify(liveResume)}`);
		}

		// 9b-ii. `registry_resync` and `session_spawn`, the geist/0.5 pair. The
		//     reference daemon has no spawn surface, so what is frozen here is the
		//     SHAPE of both answers and the daemon's honest refusal: a harness row
		//     carries no `cmd`, and a `session_spawned` that started nothing names no
		//     `sessionId`.
		a.send({ type: "registry_resync" });
		const registry = await a.expect("registry");
		if (registry.harnesses.length === 0 || registry.projects.length === 0) {
			throw new Error(`the registry answer named nothing to spawn: ${JSON.stringify(registry)}`);
		}
		// The reference registry's harness row DOES carry a `cmd`; the encoder is what
		// drops it. This reads the bytes off the socket, before any decode, so it
		// fails the moment the daemon stops encoding through the schema.
		if (registry.harnesses.some((harness) => "cmd" in harness)) {
			throw new Error(`a registry harness row carried an executable path: ${JSON.stringify(registry)}`);
		}
		a.send({ type: "session_spawn", harnessId: registry.harnesses[0].id, projectId: "no-such-project" });
		const unknownProject = await a.expect("session_spawned");
		if (unknownProject.ok !== false || unknownProject.code !== "unknown_project") {
			throw new Error(`spawn of an unknown project was not refused honestly: ${JSON.stringify(unknownProject)}`);
		}
		if ("sessionId" in unknownProject) {
			throw new Error(`a refused spawn named a session id it never minted: ${JSON.stringify(unknownProject)}`);
		}
		a.send({ type: "session_spawn", harnessId: "no-such-harness", projectId: registry.projects[0].id });
		const unknownHarness = await a.expect("session_spawned");
		if (unknownHarness.ok !== false || unknownHarness.code !== "unknown_harness") {
			throw new Error(`spawn of an unknown harness was not refused honestly: ${JSON.stringify(unknownHarness)}`);
		}
		// …and the pair that RESOLVES. It is the only verdict here reached with both ids found, so it is the
		// only one that would have a minted id to leak if this daemon minted any, and the only branch where
		// `ok` could be true without anything having been started.
		a.send({ type: "session_spawn", harnessId: registry.harnesses[0].id, projectId: registry.projects[0].id });
		const refusedSpawn = await a.expect("session_spawned");
		if (refusedSpawn.ok !== false || refusedSpawn.code !== "refused") {
			throw new Error(`spawn of a REGISTERED pair was not refused honestly: ${JSON.stringify(refusedSpawn)}`);
		}
		if ("sessionId" in refusedSpawn) {
			throw new Error(`a refused spawn named a session id it never minted: ${JSON.stringify(refusedSpawn)}`);
		}

		// 9c. `fleet_delta`, and it is a REAL diff. A second draht session is really
		//     started, the daemon is asked to observe again, and what it sends is the
		//     difference between two reads of a real directory. Then that session is
		//     really stopped and the same thing happens in reverse.
		//
		//     `appeared` carries the FULL session body, never just an id: a resumed
		//     session reuses its id with a new pid, so a client that merges on id
		//     instead of replacing keeps a dead process on screen.
		transientDaemon = await spawnDaemon("scripts/geist-conformance/socket-daemon.mjs", [
			"--socket-dir",
			socketDir,
			"--session-id",
			TRANSIENT_SESSION_ID,
			"--cwd",
			SESSION_CWD,
		]);
		referenceDaemon.child.stdin.write("rescan\n");
		const appeared = await a.expect("fleet_delta");
		await drainDelta([b, c, reconnect]);
		if (appeared.epoch !== fleet.epoch || !(appeared.seq > resynced.seq)) {
			throw new Error(`the delta is not orderable after the resync: ${JSON.stringify(appeared)}`);
		}
		const appearance = appeared.changes.find((change) => change.kind === "appeared");
		if (!appearance || appearance.session?.id !== TRANSIENT_SESSION_ID) {
			throw new Error(`starting a session did not produce an "appeared" change: ${JSON.stringify(appeared)}`);
		}
		if (appearance.session.origin !== "socket" || typeof appearance.session.pid !== "number") {
			throw new Error(`an "appeared" change did not carry a full session body: ${JSON.stringify(appearance)}`);
		}

		transientDaemon.child.stdin.write(`${JSON.stringify({ cmd: "stop" })}\n`);
		await withDeadline(new Promise((r) => transientDaemon.child.on("exit", r)), FRAME_TIMEOUT_MS, "the transient session to exit");
		referenceDaemon.child.stdin.write("rescan\n");
		const disappeared = await a.expect("fleet_delta");
		await drainDelta([b, c, reconnect]);
		if (!disappeared.changes.some((change) => change.kind === "disappeared" && change.id === TRANSIENT_SESSION_ID)) {
			throw new Error(`stopping a session did not produce a "disappeared" change: ${JSON.stringify(disappeared)}`);
		}
		if (disappeared.changes.some((change) => change.kind === "disappeared" && change.session !== undefined)) {
			throw new Error(`a "disappeared" change carried a body it should not have: ${JSON.stringify(disappeared)}`);
		}

		// 10. The rejection battery — every entry on its own connection.
		const rejections = [];
		for (const candidate of REJECTED_FRAMES) {
			const probe = await connect(`probe-${candidate.name}`);
			if (candidate.handshake) {
				probe.socket.send(JSON.stringify(HELLO_FRAME));
				await probe.next(); // server_hello — `fleet` follows the device exchange, not the handshake
			}
			probe.sendRaw(candidate.raw);
			const answer = await probe.next();
			if (answer.type !== "protocol_error") {
				throw new Error(`daemon accepted ${candidate.name}: answered ${JSON.stringify(answer)}`);
			}
			const closed = await probe.waitClosed();
			rejections.push({
				name: candidate.name,
				sent: candidate.raw,
				code: answer.code,
				expectedCode: candidate.expect,
				closed: closed !== null,
			});
		}
		// A refusal must not have disturbed the attached client — including the
		// replayed bootstrap token, which client-a spent: an invalid or replayed
		// `pair_device` on a second socket leaves the already-bound device alone
		// (R33-REACH.7).
		socketDaemon.child.stdin.write(`${JSON.stringify({ cmd: "output", data: "still here\n", stream: "stdout" })}\n`);
		if ((await a.peekType()) !== "output") throw new Error("client-a's stream did not survive the rejection battery");

		return {
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			recordedFrom: "scripts/geist-conformance/reference-daemon.mjs over ws://127.0.0.1/attach, relaying a real draht SocketServer behind a real device-credential exchange",
			normalizedFields: NORMALIZED_FIELDS,
			transcript: transcript.map((entry, seq) => ({ seq, ...entry })),
			rejections,
		};
	} finally {
		for (const client of clients) client.close();
		try {
			referenceDaemon?.child.stdin.write("stop\n");
		} catch {
			// Already exited.
		}
		try {
			socketDaemon?.child.stdin.write(`${JSON.stringify({ cmd: "stop" })}\n`);
		} catch {
			// Already exited.
		}
		referenceDaemon?.child.kill();
		socketDaemon?.child.kill();
		transientDaemon?.child.kill();
		await rm(socketDir, { recursive: true, force: true });
	}
}

/** Which fields of a recorded frame the normalization table replaced. */
export function normalizedFieldsOf(frame) {
	return [...normalizedKeysOf(frame)].sort();
}
