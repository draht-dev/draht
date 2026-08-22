/**
 * R33-REACH.6, GSEC-04 sign-off condition 2 — a revocation reaches a *live*
 * connection, not merely the next one.
 *
 * The roadmap's wording is "a revoked device is refused at its next frame, not
 * merely at its next connect". Read literally that is inbound-only, and
 * inbound-only leaves the vector the GSEC-04 adjudication actually named: a
 * phone that has attached and then goes quiet. It sends nothing, so it has no
 * "next frame" to be refused at — and a draht session that keeps printing keeps
 * feeding a revoked device, indefinitely. Revoking it in the CLI would look like
 * it worked (`geist devices list` says `revoked`) while the stolen phone watched
 * the transcript scroll past.
 *
 * So the property proved here is the *outbound* one, and it is measured the only
 * way that means anything: a real session writing real socket-wire frames, a
 * real `Bun.serve`, a real `WebSocket`, and a revocation performed by a
 * *different* `DeviceRegistry` object over the same file — which is what `geist
 * devices revoke` is to the daemon: another process, another handle, one file.
 *
 * Nothing here constructs an `AttachBridge` or calls its methods; every
 * assertion below crosses the public geist wire. Two stand-ins, both named:
 *
 *  - the draht session is a `node:net` server publishing a real `<id>.sock` and
 *    `<id>.lock`, because what has to vary here is *when* a session prints and a
 *    real agent will not print on cue;
 *  - the gateway's device store is assembled from a real `DeviceRegistry` in
 *    `storeFor()` below, because the daemon's own CLI does not yet construct one
 *    (`packages/gateway/src/cli.ts` never sets `devices`). That gap is stated in
 *    this task's notes rather than papered over: until it closes, the control
 *    proved here is reachable through `createServer({ devices })` and through
 *    nothing an operator can type.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createSocketServer, type Socket, type Server as SocketServer } from "node:net";
import { join } from "node:path";
import { DeviceRegistry } from "@draht/geist-core";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import { websocket } from "hono/bun";
import type { AttachDeviceAuthenticator } from "../gateway/routes/fleet";
import { createServer } from "../gateway/server";

/** The daemon's shared operator token. Never a device credential. */
const TOKEN = "device-revocation-live-token";
/** The streaming session: prints on a timer, so a silent client still receives. */
const LIVE = "live-session";
/** The silent session: prints nothing after `attach`, ever. */
const QUIET = "quiet-session";
/** How often the streaming session prints. Forty frames inside the 1s budget. */
const STREAM_EVERY_MS = 25;
/** The budget R33-REACH.6 is measured against. */
const BUDGET_MS = 1_000;

/** Credential lifetime the adapter stamps on an issued `device_credential`. */
const CREDENTIAL_TTL_MS = 86_400_000;

// ---------------------------------------------------------------------------
// The session side: a real Unix socket speaking the socket wire.
// ---------------------------------------------------------------------------

/** One renderer's connection to a fake session, as the session sees it. */
class SessionPeer {
	/** Every socket-wire line this session received. `attach` is line one. */
	readonly inbound: string[] = [];
	/** Highest `output` sequence number this session has *written*. */
	written = 0;
	readonly #socket: Socket;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(socket: Socket, sessionId: string, streamEveryMs: number | null) {
		this.#socket = socket;
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				this.inbound.push(line);
				if ((JSON.parse(line) as { type?: string }).type !== "attach") continue;
				this.#write({
					type: "session_metadata",
					sessionId,
					cwd: "/work/revocation",
					createdAt: new Date(0).toISOString(),
				});
				if (streamEveryMs !== null) this.#stream(streamEveryMs);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => this.stop());
	}

	/**
	 * Print forever, numbered.
	 *
	 * The sequence number is the whole measurement: the test records the highest
	 * number the *session* has written at the instant the revocation lands, and
	 * any number above it that reaches the renderer is a frame that escaped after
	 * the device was revoked.
	 */
	#stream(everyMs: number): void {
		if (this.#timer !== null) return;
		const timer = setInterval(() => {
			this.written += 1;
			this.#write({ type: "output", data: `seq:${this.written}\n`, stream: "stdout" });
		}, everyMs);
		timer.unref?.();
		this.#timer = timer;
	}

	#write(frame: unknown): void {
		try {
			this.#socket.write(`${JSON.stringify(frame)}\n`);
		} catch {
			// The bridge dropped us; the timer is cleared on close.
		}
	}

	stop(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}
}

/** A fake attachable draht session: `<id>.sock` + `<id>.lock`, live pid. */
class FakeSession {
	readonly peers: SessionPeer[] = [];
	readonly #server: SocketServer;

	private constructor(server: SocketServer) {
		this.#server = server;
	}

	static async start(socketDir: string, id: string, streamEveryMs: number | null): Promise<FakeSession> {
		let session: FakeSession | null = null;
		const server = createSocketServer((socket) => {
			session?.peers.push(new SessionPeer(socket, id, streamEveryMs));
		});
		session = new FakeSession(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(join(socketDir, `${id}.sock`), resolve);
		});
		// The lock is the liveness contract `listAttachableSessions` reads: pid, cwd,
		// ISO creation time, and — since Phase 35 — the owner's process start time in
		// ms. That 4th line is what distinguishes a live owner from a RECYCLED pid, so
		// it must be this process's real start time: a lock whose owner appears to
		// predate the machine's boot is debris and gets reaped, which is exactly what
		// this fixture's old three-line form became.
		const processStartedAtMs = Math.round(Date.now() - process.uptime() * 1000);
		writeFileSync(
			join(socketDir, `${id}.lock`),
			`${process.pid}\n/work/revocation\n${new Date(0).toISOString()}\n${processStartedAtMs}`,
			{ mode: 0o600 },
		);
		return session;
	}

	/** The peer created by the most recent attach. */
	newest(): SessionPeer {
		const peer = this.peers[this.peers.length - 1];
		if (!peer) throw new Error("no session peer has connected");
		return peer;
	}

	stop(): void {
		for (const peer of this.peers) peer.stop();
		this.#server.close();
	}
}

// ---------------------------------------------------------------------------
// The store side: the gateway's device port, over a real DeviceRegistry.
// ---------------------------------------------------------------------------

/**
 * The gateway's `devices` port, filled by a real `DeviceRegistry`.
 *
 * `observe: false` builds the store a daemon has when nothing can watch the
 * file — no `subscribe` — which is the posture test 3 isolates the inbound
 * refusal in.
 */
function storeFor(registry: DeviceRegistry, options: { observe: boolean }): AttachDeviceAuthenticator {
	const issued = (result: { deviceId: string; credential: string }) => {
		const at = Date.now();
		return {
			ok: true as const,
			deviceId: result.deviceId,
			credential: result.credential,
			issuedAt: new Date(at).toISOString(),
			expiresAt: new Date(at + CREDENTIAL_TTL_MS).toISOString(),
		};
	};
	return {
		pair(input) {
			const result = registry.exchange(input.bootstrapToken, input.device);
			return result.ok ? issued(result) : { ok: false, reason: result.reason };
		},
		authenticate(input) {
			const verified = registry.verify(input.deviceId, input.credential);
			if (!verified.ok) return { ok: false, reason: verified.outcome };
			const rotated = registry.rotate(input.deviceId);
			return rotated.ok ? issued(rotated) : { ok: false, reason: rotated.reason };
		},
		isRevoked: (deviceId) => registry.isRevoked(deviceId),
		...(options.observe ? { subscribe: (listener: () => void) => registry.subscribe(listener) } : {}),
	};
}

// ---------------------------------------------------------------------------
// The renderer side: one phone, on the public wire.
// ---------------------------------------------------------------------------

async function until<T>(probe: () => T | undefined | false | null, what: string, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = probe();
		if (value) return value as T;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** One renderer connection, collecting every frame the daemon emits. */
class Wire {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;
	#sent = 0;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			// Re-validated on arrival: nothing the daemon emits is trusted here.
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	/** Pair with a fresh bootstrap token and attach. Nothing is sent after this. */
	static async pairAndAttach(base: string, registry: DeviceRegistry, sessionId: string, clientId: string) {
		const ws = new WebSocket(`${base}/attach`);
		const wire = new Wire(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("the upgrade was refused")));
		});
		wire.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "revocation-e2e", version: "0.0.0" },
		});
		await wire.waitFor((frame) => frame.type === "server_hello", "server_hello");
		wire.send({
			type: "pair_device",
			bootstrapToken: registry.mintBootstrap().token,
			device: { name: clientId, platform: "ios" },
		});
		const credential = await wire.waitFor((frame) => frame.type === "device_credential", "device_credential");
		if (credential.type !== "device_credential") throw new Error("unreachable");
		wire.send({ type: "attach", sessionId, clientId, mode: "read-write" });
		await wire.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
		return { wire, deviceId: credential.deviceId };
	}

	send(frame: unknown): void {
		this.#sent += 1;
		this.#ws.send(JSON.stringify(frame));
	}

	/** How many frames this client has put on the wire, ever. */
	get sentCount(): number {
		return this.#sent;
	}

	/** Every `output` frame's sequence number, in arrival order. */
	sequences(): number[] {
		return this.frames
			.filter((frame) => frame.type === "output")
			.map((frame) => Number.parseInt(/^seq:(\d+)/.exec((frame as { data: string }).data)?.[1] ?? "-1", 10));
	}

	async waitFor(predicate: (frame: GeistServerFrame) => boolean, what: string): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((frame) => frame.type).join(", ")})`,
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

// ---------------------------------------------------------------------------
// Three daemons over one store file, and one revoker beside them.
// ---------------------------------------------------------------------------

let socketDir: string;
let storeDir: string;
let storePath: string;
let liveSession: FakeSession;
let quietSession: FakeSession;

/** The daemon whose store observes the file — the shipping posture. */
let watching: ReturnType<typeof Bun.serve>;
/** A daemon whose store cannot observe the file at all. */
let blind: ReturnType<typeof Bun.serve>;
/** A daemon whose store's fs watch could not be established, so it polls. */
let degraded: ReturnType<typeof Bun.serve>;
/** Every degradation the polling registry reported. Must not be empty. */
const degradations: string[] = [];

/** `geist devices revoke`, as the daemon sees it: another handle on one file. */
function revokeElsewhere(deviceId: string): void {
	const result = new DeviceRegistry({ path: storePath }).revoke(deviceId);
	expect(result).toEqual({ ok: true, deviceId });
}

function serve(app: { fetch: (request: Request) => Response | Promise<Response> }): ReturnType<typeof Bun.serve> {
	// Loopback named explicitly: a hostname-less `Bun.serve` binds every
	// interface (R32-FLEET.9).
	return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
}

beforeAll(async () => {
	// A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
	// `os.tmpdir()` is already 50 characters. Straight under /tmp.
	socketDir = mkdtempSync("/tmp/grl-sock-");
	storeDir = mkdtempSync("/tmp/grl-store-");
	storePath = join(storeDir, "devices.json");

	liveSession = await FakeSession.start(socketDir, LIVE, STREAM_EVERY_MS);
	quietSession = await FakeSession.start(socketDir, QUIET, null);

	watching = serve(
		createServer({
			port: 0,
			authToken: TOKEN,
			socketDir,
			devices: storeFor(new DeviceRegistry({ path: storePath }), { observe: true }),
		}).app,
	);
	blind = serve(
		createServer({
			port: 0,
			authToken: TOKEN,
			socketDir,
			devices: storeFor(new DeviceRegistry({ path: storePath }), { observe: false }),
		}).app,
	);
	degraded = serve(
		createServer({
			port: 0,
			authToken: TOKEN,
			socketDir,
			devices: storeFor(
				new DeviceRegistry({
					path: storePath,
					// The failure this option exists to make testable: a host where
					// `fs.watch` is unavailable — an exhausted inotify budget, a
					// filesystem that reports no events, a sandbox that refuses the
					// syscall. A watcher that silently observes nothing would turn
					// R33-REACH.6 into theatre, so the store must notice and say so.
					watchFactory: () => {
						throw new Error("fs.watch is unavailable on this host (simulated)");
					},
					pollIntervalMs: 100,
					onDegraded: (message) => degradations.push(message),
				}),
				{ observe: true },
			),
		}).app,
	);
});

afterAll(() => {
	watching?.stop(true);
	blind?.stop(true);
	degraded?.stop(true);
	liveSession?.stop();
	quietSession?.stop();
	rmSync(socketDir, { recursive: true, force: true });
	rmSync(storeDir, { recursive: true, force: true });
});

function base(server: ReturnType<typeof Bun.serve>): string {
	return `ws://127.0.0.1:${server.port}`;
}

test("revoking a device mid-stream stops every further server frame within 1s, without the client sending anything", async () => {
	const { wire: victim, deviceId } = await Wire.pairAndAttach(
		base(watching),
		new DeviceRegistry({ path: storePath }),
		LIVE,
		"victim",
	);
	const victimPeer = liveSession.newest();
	const { wire: bystander } = await Wire.pairAndAttach(
		base(watching),
		new DeviceRegistry({ path: storePath }),
		LIVE,
		"bystander",
	);
	const bystanderPeer = liveSession.newest();

	// Both are genuinely mid-stream before anything is revoked.
	await until(() => victim.sequences().length >= 3, "the victim's stream to start");
	await until(() => bystander.sequences().length >= 3, "the bystander's stream to start");
	const sentBefore = victim.sentCount;

	// The revocation, performed by another handle on the same file — and the
	// highest number the session had printed at that instant. Both are read
	// synchronously, so no frame can slip between them.
	revokeElsewhere(deviceId);
	const cutoff = victimPeer.written;
	const bystanderCutoff = bystanderPeer.written;
	const revokedAt = Date.now();

	// The headline: torn down, inside the budget, having sent nothing.
	const closed = await until(() => victim.closed, "the revoked connection to be dropped");
	expect(Date.now() - revokedAt).toBeLessThan(BUDGET_MS);
	expect(closed.code).toBe(1008);
	expect(victim.sentCount).toBe(sentBefore);

	// …and not one frame of the session's output escaped after the revocation.
	// The session kept printing throughout — `written` climbed past the cutoff —
	// so this is a bound on what was relayed, not on what was produced.
	await Bun.sleep(200);
	expect(victimPeer.written).toBeGreaterThan(cutoff);
	expect(victim.sequences().filter((seq) => seq > cutoff)).toEqual([]);
	expect(victim.frames[victim.frames.length - 1]).toMatchObject({
		type: "protocol_error",
		code: "not_authenticated",
	});

	// The other device on the same session is untouched: still open, still
	// receiving numbers minted after the revocation, with no gap in between.
	expect(bystander.closed).toBeNull();
	await until(
		() => bystander.sequences().some((seq) => seq > bystanderCutoff),
		"the bystander to receive output minted after the revocation",
	);
	const seen = bystander.sequences();
	expect(seen).toEqual(Array.from({ length: seen.length }, (_, index) => index + 1));
	expect(bystander.frames.some((frame) => frame.type === "protocol_error")).toBe(false);

	victim.close();
	bystander.close();
}, 20_000);

test("a silent revoked device receives zero further server frames within 1s, having sent nothing since attach", async () => {
	// The vector the roadmap's "refused at its next frame" misses entirely: this
	// client has no next frame. It attached and went quiet, and the session it is
	// attached to prints nothing either. Only a push from the store can reach it.
	const { wire, deviceId } = await Wire.pairAndAttach(
		base(watching),
		new DeviceRegistry({ path: storePath }),
		QUIET,
		"silent",
	);
	const peer = quietSession.newest();
	const framesBefore = wire.frames.length;
	const sentBefore = wire.sentCount;

	revokeElsewhere(deviceId);
	const revokedAt = Date.now();

	const closed = await until(() => wire.closed, "the silent revoked connection to be dropped");
	expect(Date.now() - revokedAt).toBeLessThan(BUDGET_MS);
	expect(closed.code).toBe(1008);
	// The client said nothing, and the session said nothing: the teardown was not
	// provoked by either end.
	expect(wire.sentCount).toBe(sentBefore);
	expect(peer.inbound.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["attach"]);
	// Zero further server frames — the refusal that explains the close is the
	// only thing that may follow, and a transcript with a hole in it is not an
	// acceptable alternative to it.
	expect(wire.frames.slice(framesBefore).map((frame) => frame.type)).toEqual(["protocol_error"]);
	expect(wire.frames[wire.frames.length - 1]).toMatchObject({ code: "not_authenticated" });

	wire.close();
}, 20_000);

test("the next inbound frame from a revoked device is refused, and never reaches the session", async () => {
	// This daemon's store cannot observe the file — no `subscribe` — so nothing
	// pushes. It isolates the inbound half of R33-REACH.6: the refusal that has
	// to hold on the frame the device itself sends, whatever else is or is not
	// watching.
	const { wire, deviceId } = await Wire.pairAndAttach(
		base(blind),
		new DeviceRegistry({ path: storePath }),
		QUIET,
		"talker",
	);
	const peer = quietSession.newest();

	revokeElsewhere(deviceId);
	// Nothing has torn this connection down: there is nothing here that could.
	await Bun.sleep(150);
	expect(wire.closed).toBeNull();

	wire.send({ type: "input", data: "rm -rf /\n", clientId: "talker" });

	const refusal = await wire.waitFor((frame) => frame.type === "protocol_error", "the refusal");
	expect(refusal).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect((await until(() => wire.closed, "the close after the refusal")).code).toBe(1008);
	// The frame died at the bridge. The session saw the attach and nothing after.
	expect(peer.inbound.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["attach"]);

	wire.close();
}, 20_000);

test("a store whose fs watch cannot be established says so and still reaches a live connection, on a bounded poll", async () => {
	const { wire, deviceId } = await Wire.pairAndAttach(
		base(degraded),
		new DeviceRegistry({ path: storePath }),
		QUIET,
		"degraded",
	);
	const sentBefore = wire.sentCount;

	// A watcher that silently observes nothing is worse than no watcher: it makes
	// the security control look present. So the registry has to notice the moment
	// something asks to observe it, say so, and keep the property — on a poll
	// bounded well inside the budget.
	expect(degradations.length).toBeGreaterThan(0);
	expect(degradations.join("\n")).toContain("poll");

	revokeElsewhere(deviceId);
	const revokedAt = Date.now();

	const closed = await until(() => wire.closed, "the polling store to notice the revocation");
	expect(Date.now() - revokedAt).toBeLessThan(BUDGET_MS);
	expect(closed.code).toBe(1008);
	expect(wire.sentCount).toBe(sentBefore);

	wire.close();
}, 20_000);
