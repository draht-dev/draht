/**
 * R35-ALWAYS.10 — an open `/attach` connection learns the fleet moved, and can
 * recover from having missed it, WITHOUT reconnecting.
 *
 * CLASS 3, over the public protocol only. Two kinds of real process, neither of
 * them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) run with
 *     `--attachable --mode rpc`, publishing a real `<id>.sock` + `.lock` with a
 *     real pid — `--mode rpc` is required because with no TTY `resolveAppMode`
 *     falls through to print mode and the process exits before anything can
 *     attach;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`).
 *
 * Everything asserted below crosses the wire: `fetch` for `GET /fleet`, a real
 * `WebSocket` for `/attach`. Nothing here constructs `FleetObserver`,
 * `AttachBridge` or `createServer` — a package-level test that did could pass
 * while the shipped daemon pushed no delta at all, which is exactly the state
 * this file was written against.
 *
 * THE BASELINE IT REPLACES, measured on this daemon before the change: an
 * authenticated `/attach` socket received `server_hello` + ONE `fleet` frame and
 * nothing else, ever. A session that appeared ten seconds later was still
 * invisible to that connection thirty seconds on, while `GET /fleet` against the
 * same daemon listed it.
 *
 * The load-bearing assertion is TRUTHFULNESS, not delivery: the snapshot a
 * `fleet_resync` answers with must BE the fleet at the `seq` it names, judged
 * the instant it arrives and against a witness that is not the stream under
 * test. Delivery alone would be satisfied by a stream that silently corrupts a
 * renderer's view.
 *
 * CONVERGENCE IS ASSERTED TOO, AND IT IS THE WEAKER CLAIM. A lossy client and a
 * faithful one do end up byte-identical — but they would also do so if the
 * resync answered with nothing at all, because the ~0.3 Hz `changed` stream
 * re-states every live row wholesale within a few seconds. Read the two
 * assertions in that order: the one on the received frame is the requirement,
 * the one on the settled views is the end state a renderer lives in.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type AttachableSession,
	type FleetDeltaFrame,
	type FleetFrame,
	FleetFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
	type ServerHelloFrame,
} from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "fleet-delta-e2e-token";

/** The capability a renderer declares in `attach` to be sent `fleet_delta`. */
const FLEET_DELTA = "fleet-delta";

/**
 * A fleet frame or a delta — the two frames that carry `epoch` and `seq`.
 *
 * Both halves are imported from the protocol rather than re-declared here: a
 * local restatement of a wire shape is a second, drifting copy of the contract,
 * and `check:geist-protocol` refuses one.
 */
type FleetFrameLike = FleetFrame | FleetDeltaFrame;

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. The
 * agent directory therefore lives directly under /tmp.
 */
const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	stderr: { text: string };
}

function sockets(socketDir: string): string[] {
	try {
		return readdirSync(socketDir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

async function startDrahtSession(): Promise<DrahtSession> {
	const cwd = tempDir("fdc-");
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
				DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "25",
			},
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);

	const socketDir = join(agentDir, "sockets");
	const before = new Set(sockets(socketDir));
	const id = await until(() => {
		if (proc.exitCode !== null) {
			throw new Error(
				`draht exited with code ${proc.exitCode} before publishing a socket.\nstderr:\n${stderr.text}`,
			);
		}
		return sockets(socketDir).find((entry) => !before.has(entry));
	}, `draht to publish its socket (stderr: ${stderr.text})`);
	return { proc, id: id.slice(0, -".sock".length), cwd, stderr };
}

async function killSession(session: DrahtSession): Promise<void> {
	session.proc.kill("SIGKILL");
	await session.proc.exited;
}

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/**
 * A set of fleet rows as bytes, in an order neither side chose.
 *
 * ONE definition, used both for a renderer's applied model and for a raw frame's
 * `sessions` array, because the two are compared against each other below: a
 * second normalisation would let a difference in sort order read as a difference
 * in state (or, worse, hide one).
 */
function serializeRows(sessions: readonly AttachableSession[]): string {
	return JSON.stringify([...sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/**
 * A renderer's model of the fleet, maintained exactly as the wire prescribes.
 *
 * A snapshot REPLACES; `appeared` and `changed` REPLACE the row wholesale rather
 * than merging into it (a resume reuses one id with a new pid, so a merge would
 * keep a dead one); `disappeared` deletes. This is the object convergence is
 * asserted on, and it is deliberately dumb — the point is that a client with no
 * cleverness in it lands byte-identically whether or not it saw every frame.
 */
class FleetView {
	rows = new Map<string, AttachableSession>();
	epoch: string | null = null;
	seq = -1;

	applySnapshot(frame: FleetFrame): void {
		this.rows = new Map(frame.sessions.map((session) => [session.id, session]));
		this.epoch = frame.epoch;
		this.seq = frame.seq;
	}

	applyDelta(frame: FleetDeltaFrame): void {
		for (const change of frame.changes) {
			if (change.kind === "disappeared") this.rows.delete(change.id);
			else this.rows.set(change.session.id, change.session);
		}
		this.epoch = frame.epoch;
		this.seq = frame.seq;
	}

	/** The state as bytes. Sorted by id so two views cannot differ by arrival order. */
	serialize(): string {
		return serializeRows([...this.rows.values()]);
	}
}

/**
 * The epoch a view has settled on.
 *
 * Throws rather than letting a comparison run against `null`: `expect(x).toBe(null)`
 * on two views that never received a frame would pass, and would pass loudest
 * exactly when the stream is broken.
 */
function epochOf(view: FleetView): string {
	if (view.epoch === null) throw new Error("this view has received no fleet frame");
	return view.epoch;
}

/** One renderer, driven exactly as a phone would drive it. */
class Renderer {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	/** The live model, fed by every fleet frame this connection is willing to apply. */
	readonly view = new FleetView();
	/** While true, `fleet_delta` frames are received and deliberately NOT applied. */
	dropDeltas = false;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			// Re-validated on arrival: nothing the daemon emits is trusted here any
			// more than a renderer's bytes are trusted there. A `fleet_delta` missing
			// `epoch` or `seq` fails this parse.
			const frame = ServerFrameSchema.parse(JSON.parse(String(event.data)));
			this.frames.push(frame);
			if (frame.type === "fleet") this.view.applySnapshot(frame);
			else if (frame.type === "fleet_delta" && !this.dropDeltas) this.view.applyDelta(frame);
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(): Promise<Renderer> {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${wsBase}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		const renderer = new Renderer(ws);
		await new Promise<void>((res, rej) => {
			ws.addEventListener("open", () => res());
			ws.addEventListener("error", () => rej(new Error("websocket refused")));
		});
		return renderer;
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	async handshake(): Promise<ServerHelloFrame> {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "delta-e2e-renderer", version: "0.0.0" },
		});
		await this.waitFor((frame) => frame.type === "fleet", "the fleet frame");
		return this.frames.find((frame) => frame.type === "server_hello") as ServerHelloFrame;
	}

	/** Attach, declaring (or withholding) the delta capability. */
	async attach(sessionId: string, clientId: string, capabilities?: string[]): Promise<void> {
		this.send({
			type: "attach",
			sessionId,
			clientId,
			mode: "read-write",
			...(capabilities === undefined ? {} : { capabilities }),
		});
		await this.waitFor((frame) => frame.type === "session_metadata", `session_metadata for ${sessionId}`);
	}

	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs = 20_000,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((f) => f.type).join(", ")})`,
			timeoutMs,
		);
	}

	/** Every `epoch`/`seq`-carrying frame this connection has received, in order. */
	fleetFrames(): FleetFrameLike[] {
		return this.frames.filter(
			(frame): frame is FleetFrameLike => frame.type === "fleet" || frame.type === "fleet_delta",
		);
	}

	deltas(): FleetDeltaFrame[] {
		return this.frames.filter((frame): frame is FleetDeltaFrame => frame.type === "fleet_delta");
	}

	/** Every full `fleet` snapshot this connection was sent, in order. */
	snapshots(): FleetFrame[] {
		return this.frames.filter((frame): frame is FleetFrame => frame.type === "fleet");
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
 * The ordering contract, asserted on a whole connection's stream.
 *
 * ONE EPOCH — a second epoch inside one daemon run would mean two observers, and
 * a renderer holding rows from both has no way to order them.
 *
 * NO GAP BEFORE A DELTA — every `fleet_delta` carries exactly one more than the
 * frame before it. This is the assertion the requirement rests on: a delta
 * applied to a state it does not immediately follow silently corrupts the view,
 * and `seq` is the ONLY thing that makes that detectable.
 *
 * A snapshot may jump forward (that is what a resync is) but never backward.
 */
function assertOrdered(renderer: Renderer): void {
	const frames = renderer.fleetFrames();
	expect(frames.length).toBeGreaterThan(0);
	const epochs = new Set(frames.map((frame) => frame.epoch));
	expect([...epochs]).toHaveLength(1);
	let previous = -1;
	for (const frame of frames) {
		if (frame.type === "fleet_delta") expect(frame.seq).toBe(previous + 1);
		else expect(frame.seq).toBeGreaterThanOrEqual(previous);
		previous = frame.seq;
	}
}

let agentDir: string;
let home: string;
let wsBase: string;
let httpBase: string;
let anchor: DrahtSession;
let daemonStderr: { text: string };

async function fleetBody(): Promise<FleetFrame> {
	const response = await fetch(`${httpBase}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	return FleetFrameSchema.parse(await response.json()) as FleetFrame;
}

/**
 * Send one `fleet_resync` and bring back its answer TOGETHER WITH an independent
 * witness of the same observer state.
 *
 * WHY THE SANDWICH. The answer to a resync has to be judged against the truth at
 * the instant it was produced, and the only surface that can testify to that
 * instant without being the stream under test is `GET /fleet` — answered from
 * the same observer, so its `epoch`/`seq` are comparable, but reached over HTTP
 * rather than over the socket being exercised. So `GET /fleet` is taken BEFORE
 * the verb and AFTER the answer, and the attempt only counts when all three
 * agree on one `seq`. `seq` counts state transitions, so three equal values mean
 * the observer did not move across the whole window: the witness describes
 * exactly the state the answer was built from, and no `fleet_delta` was emitted
 * in between that could have quietly repaired anything.
 *
 * A mismatched `seq` is a RETRY, never a failure — the fleet moving during the
 * exchange is ordinary (a status probe alone moves it), and a test that failed
 * on it would be asserting the fleet is idle rather than that the resync is
 * truthful.
 */
async function resyncWithWitness(renderer: Renderer): Promise<{ answer: FleetFrame; witness: FleetFrame }> {
	for (let attempt = 0; attempt < 12; attempt++) {
		const before = await fleetBody();
		const seen = renderer.snapshots().length;
		renderer.send({ type: "fleet_resync" });
		const answer = await until(() => renderer.snapshots()[seen], "the snapshot answering fleet_resync");
		const after = await fleetBody();
		if (before.seq === after.seq && answer.seq === before.seq) return { answer, witness: after };
	}
	throw new Error("the fleet never held still long enough to witness one resync answer");
}

beforeAll(async () => {
	// Built unconditionally: the artifact under test is emitted, not committed,
	// so "it already exists" says nothing about whether it matches this tree.
	const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("fda-");
	home = tempDir("fdh-");

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(() => daemonStderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");

	httpBase = `http://127.0.0.1:${port}`;
	wsBase = `ws://127.0.0.1:${port}`;
	// One long-lived session for connections to attach TO. Nothing asserted below
	// kills it: the bridge closes a connection whose own session ends, and this
	// file is about what a connection learns while it stays open.
	anchor = await startDrahtSession();
}, 300_000);

afterAll(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("server_hello advertises what this daemon will answer (geist/0.4)", () => {
	test("declares fleet-delta, so a renderer knows the stream exists before asking", async () => {
		const renderer = await Renderer.open();
		const hello = await renderer.handshake();
		expect(hello.capabilities).toContain(FLEET_DELTA);
		renderer.close();
	}, 60_000);
});

describe("fleet_delta on an open connection (R35-ALWAYS.10)", () => {
	test("a session that appears reaches the SAME socket, in order, with its full body", async () => {
		const renderer = await Renderer.open();
		await renderer.handshake();
		await renderer.attach(anchor.id, "delta-watcher", [FLEET_DELTA]);

		const snapshot = renderer.fleetFrames().at(-1);
		if (snapshot === undefined) throw new Error("no fleet frame after attach");
		expect(snapshot.type).toBe("fleet");
		const deltasBefore = renderer.deltas().length;

		const second = await startDrahtSession();

		const appeared = (await until(() => {
			for (const delta of renderer.deltas()) {
				const change = delta.changes.find((c) => c.kind === "appeared" && c.session.id === second.id);
				if (change !== undefined) return { delta, change };
			}
			return undefined;
		}, `an appeared delta for ${second.id}`)) as {
			delta: FleetDeltaFrame;
			change: { kind: "appeared"; session: AttachableSession };
		};

		// Same observer run as the snapshot this connection started from.
		expect(appeared.delta.epoch).toBe(snapshot.epoch);
		// The FULL body, never just an id — a renderer replaces the row wholesale.
		expect(appeared.change.session).toMatchObject({
			id: second.id,
			pid: second.proc.pid,
			origin: "socket",
			attachable: true,
			resumable: false,
		});
		expect(appeared.change.session.cwd.length).toBeGreaterThan(0);
		expect(Number.isFinite(Date.parse(appeared.change.session.startedAt))).toBe(true);

		// It arrived as a delta, on the connection that was already open, and that
		// connection was never dropped. This is the whole requirement.
		expect(renderer.deltas().length).toBeGreaterThan(deltasBefore);
		expect(renderer.closed).toBeNull();
		assertOrdered(renderer);

		// And the renderer's applied model now holds it — delivery is not the
		// claim, a correct view is.
		expect(renderer.view.rows.get(second.id)?.pid).toBe(second.proc.pid);

		// Killed AND waited for. A `.sock` is reaped by the observer's next scan,
		// which may be up to a poll period away — long enough to land in the NEXT
		// test's renderer as a `disappeared` for a session that test never started.
		// Every test in this file therefore leaves the fleet as it found it.
		await killSession(second);
		await until(() => !renderer.view.rows.has(second.id), `${second.id} to leave the fleet`);
		renderer.close();
	}, 120_000);

	test("killing a live session emits a disappeared delta on that same socket", async () => {
		const renderer = await Renderer.open();
		await renderer.handshake();
		await renderer.attach(anchor.id, "removal-watcher", [FLEET_DELTA]);

		const doomed = await startDrahtSession();
		await until(() => renderer.view.rows.has(doomed.id), `${doomed.id} to enter the renderer's view`);

		await killSession(doomed);

		const removal = await until(
			() =>
				renderer
					.deltas()
					.find((delta) => delta.changes.some((c) => c.kind === "disappeared" && c.id === doomed.id)),
			`a disappeared delta for ${doomed.id}`,
		);
		expect(removal.epoch).toBe(epochOf(renderer.view));
		expect(renderer.view.rows.has(doomed.id)).toBe(false);
		expect(renderer.closed).toBeNull();
		assertOrdered(renderer);
		renderer.close();
	}, 120_000);

	test("a renderer that declares no fleet-delta capability gets one snapshot and nothing after it", async () => {
		const deaf = await Renderer.open();
		await deaf.handshake();
		// No `capabilities` at all — an older renderer, which would fail to decode
		// a frame type it has never heard of.
		await deaf.attach(anchor.id, "deaf-watcher");

		const listener = await Renderer.open();
		await listener.handshake();
		await listener.attach(anchor.id, "listening-watcher", [FLEET_DELTA]);

		// Churn, and use the SUBSCRIBED connection as the synchronisation point:
		// once it has seen both transitions, the daemon has finished emitting for
		// them, so "the deaf one received nothing" is an observation rather than a
		// race with a frame still in flight.
		const churn = await startDrahtSession();
		await until(() => listener.view.rows.has(churn.id), `${churn.id} to reach the subscribed renderer`);
		await killSession(churn);
		await until(() => !listener.view.rows.has(churn.id), `${churn.id} to leave the subscribed renderer`);
		await Bun.sleep(1_500);

		expect(deaf.frames.filter((frame) => frame.type === "fleet")).toHaveLength(1);
		expect(deaf.deltas()).toHaveLength(0);
		expect(deaf.closed).toBeNull();
		deaf.close();
		listener.close();
	}, 120_000);

	test("a connection whose fleet moved between hello and attach is re-based, not left with a gap", async () => {
		const renderer = await Renderer.open();
		await renderer.handshake();
		const hello = renderer.snapshots()[0];
		if (hello === undefined) throw new Error("no fleet frame after hello");

		// THE WINDOW, and it exists on every real client. `hello` answers with a
		// snapshot; `attach` is the only frame carrying `capabilities`, so it is
		// where the delta subscription is armed. A transition that lands in between
		// was announced by neither — and a subscription armed on top of the stale
		// `hello` seq delivers a first delta with a HOLE in front of it, which is
		// precisely the thing `seq` exists to make undetectable-proof.
		//
		// The transition is DRIVEN here rather than waited for. Nothing else in
		// this file moves the fleet between those two frames, which is exactly why
		// removing the re-base costs nothing anywhere else in it.
		const mover = await startDrahtSession();
		// Witnessed on `GET /fleet`: the same observer read over the OTHER surface,
		// so "the fleet has moved past the hello snapshot" is established without
		// the socket under test having been told anything at all.
		const moved = await until(async () => {
			const body = await fleetBody();
			return body.seq > hello.seq && body.sessions.some((session) => session.id === mover.id) ? body : undefined;
		}, `GET /fleet to show ${mover.id} at a seq past the hello snapshot`);

		await renderer.attach(anchor.id, "rebase-watcher", [FLEET_DELTA]);

		// A SECOND snapshot, and it is the re-base: same observer run, a seq no
		// older than the one the HTTP witness reported, and the row that appeared
		// during the window already in it. Without the re-base this connection has
		// exactly one snapshot and it is the stale one.
		const snapshots = renderer.snapshots();
		expect(snapshots).toHaveLength(2);
		const rebase = snapshots[1];
		if (rebase === undefined) throw new Error("attach emitted no re-base snapshot");
		expect(rebase.epoch).toBe(hello.epoch);
		expect(rebase.seq).toBeGreaterThanOrEqual(moved.seq);
		expect(rebase.sessions.map((session) => session.id)).toContain(mover.id);

		// And the stream continues from THAT snapshot: the first delta this
		// connection is ever sent is exactly one past the frame it was re-based on,
		// so the renderer can apply it without asking anything.
		const churn = await startDrahtSession();
		const first = await until(() => renderer.deltas()[0], "the first delta after the re-base");
		expect(first.seq).toBe(rebase.seq + 1);
		expect(renderer.closed).toBeNull();
		assertOrdered(renderer);

		// Both sessions are killed AND their removal waited for on this connection.
		// A socket reaped after the next test opened its own renderer would surface
		// there as a `disappeared` for a session that test never started.
		await killSession(mover);
		await killSession(churn);
		await until(
			() => !renderer.view.rows.has(mover.id) && !renderer.view.rows.has(churn.id),
			"the sessions this test started to leave the fleet",
		);
		renderer.close();
	}, 180_000);
});

describe("fleet_resync converges a client that lost the thread (R35-ALWAYS.10)", () => {
	test("a client that drops every delta and resyncs reaches byte-identical state to one that did not", async () => {
		const faithful = await Renderer.open();
		const lossy = await Renderer.open();
		await faithful.handshake();
		await lossy.handshake();
		await faithful.attach(anchor.id, "faithful", [FLEET_DELTA]);
		await lossy.attach(anchor.id, "lossy", [FLEET_DELTA]);

		// From here the lossy client behaves like a phone whose radio slept: the
		// frames arrive, and it does not apply them.
		lossy.dropDeltas = true;

		const appearing = await startDrahtSession();
		await until(() => faithful.view.rows.has(appearing.id), `${appearing.id} to reach the faithful renderer`);
		const vanishing = await startDrahtSession();
		await until(() => faithful.view.rows.has(vanishing.id), `${vanishing.id} to reach the faithful renderer`);
		await killSession(vanishing);
		await until(() => !faithful.view.rows.has(vanishing.id), `${vanishing.id} to leave the faithful renderer`);

		// It really did diverge. Without this the convergence below could be
		// satisfied by a client that never missed anything.
		expect(lossy.view.serialize()).not.toBe(faithful.view.serialize());
		expect(lossy.deltas().length).toBeGreaterThan(0);

		// The recovery: a distinct verb, on the SAME socket, mid-attachment.
		lossy.dropDeltas = false;
		const { answer, witness } = await resyncWithWitness(lossy);

		// NOT closed. A repeated `hello` is `invalid_frame` + 1008 and an unknown
		// type is `unknown_type` + 1008; a resync that behaved like either would be
		// the exact outcome it exists to avoid.
		expect(lossy.closed).toBeNull();
		expect(lossy.frames.filter((frame) => frame.type === "protocol_error")).toHaveLength(0);

		// THE ASSERTION THE REQUIREMENT IS FOR — and it is made on the ANSWER, as
		// received, not on the view some later frame may have repaired.
		//
		// The snapshot a resync returns must BE the fleet at the seq it names. Its
		// witness is `GET /fleet` taken across the same motionless window (see
		// `resyncWithWitness`): the same observer, a different surface, not the
		// stream under test. Compared row for row, not merely counted — a resync
		// that answered with the right ids and a stale `pid` would be a renderer
		// dialling a dead process.
		expect(answer.epoch).toBe(witness.epoch);
		expect(serializeRows(answer.sessions)).toBe(serializeRows(witness.sessions));
		// And stated once without reference to the witness at all, so that an
		// answer and a witness broken in the same way still fails here: the two
		// sessions this test KNOWS are alive are in it.
		expect(answer.sessions.map((session) => session.id)).toContain(anchor.id);
		expect(answer.sessions.map((session) => session.id)).toContain(appearing.id);

		// A WEAKER, TRUE PROPERTY, kept because it is the end state a renderer
		// actually lives in — and labelled weaker so nobody reads it as the
		// requirement. It is satisfied the moment the two views agree, and the
		// ~0.3 Hz `changed` stream re-states every live row WHOLESALE within a few
		// seconds, so a view can converge on the truth without the resync that
		// preceded it ever having told it any. What the resync itself answered is
		// settled above, on the frame, at the instant it landed.
		const settled = await until(async () => {
			const body = await fleetBody();
			return faithful.view.seq === lossy.view.seq && body.seq === lossy.view.seq ? body : undefined;
		}, "the two renderers and GET /fleet to settle on one seq");

		expect(epochOf(lossy.view)).toBe(epochOf(faithful.view));
		expect(settled.epoch).toBe(epochOf(faithful.view));
		expect(lossy.view.serialize()).toBe(faithful.view.serialize());

		// And it can continue from the seq it was given rather than having to
		// reconnect for the next change: one more transition, applied as a delta.
		const after = await startDrahtSession();
		await until(() => lossy.view.rows.has(after.id), `${after.id} to arrive as a delta after the resync`);
		expect(lossy.view.serialize()).toBe(
			await until(
				() => (faithful.view.seq === lossy.view.seq ? faithful.view.serialize() : undefined),
				"the faithful renderer to reach the same seq",
			),
		);
		assertOrdered(lossy);
		assertOrdered(faithful);

		// Left as found — see the note on the first test in this file.
		await killSession(appearing);
		await killSession(after);
		await until(
			() => !faithful.view.rows.has(appearing.id) && !faithful.view.rows.has(after.id),
			"the sessions this test started to leave the fleet",
		);
		faithful.close();
		lossy.close();
	}, 180_000);
});

describe("one observer, one reaper (R35-ALWAYS.10)", () => {
	test("hammering GET /fleet while sessions churn never fabricates a disappeared for a live session", async () => {
		const renderer = await Renderer.open();
		await renderer.handshake();
		await renderer.attach(anchor.id, "concurrency-watcher", [FLEET_DELTA]);

		const alive: DrahtSession[] = [];
		const killed = new Set<string>();
		let stop = false;

		// The hammer. Every one of these used to build its OWN projection of the
		// socket directory — and that projection REAPS, so the number of processes
		// deleting files in there was the number of clients polling.
		// Collected in BATCHES, not flattened: eight requests issued together are
		// concurrent, so the array order they land in says nothing about the order
		// the daemon answered them. What IS ordered is batch against batch — every
		// request in batch N was issued after every request in batch N-1 had
		// already answered — and that is the relation asserted below.
		const batches: FleetFrame[][] = [];
		const hammer = (async () => {
			while (!stop) {
				batches.push(await Promise.all(Array.from({ length: 8 }, () => fleetBody())));
			}
		})();

		for (let round = 0; round < 3; round++) {
			const born = await startDrahtSession();
			alive.push(born);
			await until(() => renderer.view.rows.has(born.id), `${born.id} to reach the renderer`);
			if (round > 0) {
				const victim = alive.shift();
				if (victim === undefined) throw new Error("no victim");
				await killSession(victim);
				killed.add(victim.id);
				await until(() => !renderer.view.rows.has(victim.id), `${victim.id} to leave the renderer`);
			}
		}
		stop = true;
		await hammer;

		// THE PROPERTY: every removal this connection was told about names a
		// session that really did die. A spurious `disappeared` for a live session
		// is what a second, racing reaper produces, and it would show up here.
		const removedIds = renderer
			.deltas()
			.flatMap((delta) => delta.changes)
			.filter((change) => change.kind === "disappeared")
			.map((change) => change.id);
		expect(removedIds.length).toBeGreaterThan(0);
		for (const id of removedIds) expect(killed.has(id)).toBe(true);
		// The anchor never left, however hard the directory was read.
		expect(removedIds).not.toContain(anchor.id);
		expect(renderer.view.rows.has(anchor.id)).toBe(true);

		// ONE TRUTH ACROSS BOTH SURFACES. Every HTTP body carried the same epoch
		// the socket was stamped with, and its seq never went backwards — which is
		// only possible if the route and the bridge read one observer rather than
		// each scanning for itself.
		const bodies = batches.flat();
		expect(bodies.length).toBeGreaterThan(8);
		for (const body of bodies) expect(body.epoch).toBe(epochOf(renderer.view));
		let previous = -1;
		for (const batch of batches) {
			for (const body of batch) expect(body.seq).toBeGreaterThanOrEqual(previous);
			previous = Math.max(...batch.map((body) => body.seq));
		}
		// And the run really did advance through several observer states while all
		// that reading was going on — otherwise the relation above holds trivially.
		expect(previous).toBeGreaterThan(0);
		assertOrdered(renderer);
		expect(renderer.closed).toBeNull();

		for (const session of alive) await killSession(session);
		renderer.close();
	}, 240_000);
});
