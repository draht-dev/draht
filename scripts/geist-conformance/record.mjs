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
export async function recordCorpus() {
	const socketDir = await mkdtemp(join(tmpdir(), "geist-conformance-"));
	let socketDaemon;
	let referenceDaemon;
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
		if (fleet.sessions.length !== 1 || fleet.sessions[0].id !== SESSION_ID) {
			throw new Error(`fleet did not report the running session: ${JSON.stringify(fleet)}`);
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

		// 7a. device-a comes back on a fresh socket and authenticates with the
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
		await rm(socketDir, { recursive: true, force: true });
	}
}

/** Which fields of a recorded frame the normalization table replaced. */
export function normalizedFieldsOf(frame) {
	return [...normalizedKeysOf(frame)].sort();
}
