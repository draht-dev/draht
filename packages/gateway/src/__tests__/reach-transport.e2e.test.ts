/**
 * P33-T19 — the phase's headline transport gate.
 *
 * R33-REACH.3, .5, .6, .7, .8 and GSEC-04 sign-off conditions 1–3, proved
 * against the *emitted* binaries behind the TLS-terminating reverse proxy that
 * reproduces the `tailscale serve` topology. Class 3, and the word is used
 * literally here: three real processes, none of them imported.
 *
 *   • `packages/coding-agent/dist/cli.js` — the file `bin.draht` points at, run
 *     `--attachable --mode rpc` against the in-repo keyless stub provider, so it
 *     publishes a real `<id>.sock` + `.lock` and answers real prompts;
 *   • `packages/gateway/src/cli.ts` — the file `bin.draht-gateway` points at,
 *     spawned with `bun`, bound to an ephemeral loopback port;
 *   • `packages/geist/dist/cli.js` — the file `bin.geist` points at, spawned for
 *     `geist pair` and `geist devices revoke`, sharing exactly one credential
 *     store file with the daemon.
 *
 * Nothing below imports `createServer`, `AttachBridge`, `DeviceRegistry` or any
 * other daemon internal. Every assertion crosses a wire: TLS to the fixture,
 * `wss://` to the daemon, `lsof` to the kernel, or a child process's own exit
 * code and stdout. A package-level test of the same properties would pass in a
 * process that binds nothing and ships nothing — which is exactly the rev-7
 * failure this project was audited over.
 *
 * ## The eight clauses
 *
 *   1. `?token=<valid>` over `wss://` is refused; the same secret presented as a
 *      *first message* is accepted (R33-REACH.3).
 *   2. A bootstrap token is accepted exactly once, its replay refused, and the
 *      connection the first exchange bound keeps streaming throughout
 *      (R33-REACH.5, R33-REACH.7).
 *   3. A wrong-token `pair_device` on a second socket leaves the first device
 *      authorized and undisturbed (R33-REACH.7, GSEC-08).
 *   4. `geist devices revoke` makes the *next frame* from that device refused
 *      (R33-REACH.6).
 *   5. A forged identity header naming a non-owner is refused (R33-REACH.8).
 *   6. A request with no identity header is still subject to full credential
 *      auth (R33-REACH.8, "absence never grants").
 *   7. A forged identity header naming the **owner**, with no credential and
 *      again with an invalid one, is refused both times — the case a local
 *      process actually produces, and the proof the header is never the only
 *      check (R33-REACH.8, "never the only check").
 *   8. A rotated-away predecessor credential presented after rotation is refused
 *      and surfaces a reuse event (R33-REACH.5, GSEC-04's theft signal).
 *
 * plus the bind, sampled for the whole run rather than at one instant.
 *
 * ## What this suite deliberately does not claim
 *
 * **It does not name tailscale's identity header.** {@link IDENTITY_HEADER}
 * below is a test-chosen name written into the daemon's `tailnet.header`
 * config key and into the fixture's `--identity-header` flag. The real header
 * has never been observed on this machine; it is pinned as a marked placeholder
 * in `fixtures/tailnet-identity.captured.json`, and `tailnet-identity.test.ts`
 * stays red until a human captures it from a live tailnet. Clauses 5–7 prove the
 * *policy* — deny-only, absence-never-grants, never-the-only-check — over a
 * header whose name is configuration. They prove nothing about which name
 * Tailscale sends, and a reader must not take them to.
 *
 * ## The build state this evidence depends on
 *
 * `beforeAll` rebuilds `@draht/coding-agent` and `@draht/geist` unconditionally,
 * with `npm run build` in each package, and fails if the artifact is missing
 * afterwards. Not "build if absent": the recorded lesson is that `npm run build`
 * and `npm run build:binary` clobbered each other so that exactly one entrypoint
 * worked at a time, and a suite that accepts whichever build happened to run
 * last is a suite whose green says nothing about this source tree.
 * `packages/gateway`'s own bin is a `.ts` file run by `bun`, so it has no build
 * step to reproduce.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import { describeListeners, isLoopbackListener, type Listener, watchListeners } from "./helpers/listening-sockets";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GEIST_CLI = join(REPO_ROOT, "packages", "geist", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TLS_PROXY = join(REPO_ROOT, "scripts", "fixtures", "tls-proxy.mjs");

/** The daemon's shared operator token. Never a device credential. */
const TOKEN = "reach-transport-e2e-operator-token";
/** The tailnet login the configured `tailnet.owner` names. */
const OWNER = "owner@reach-transport.test";
/** Any other tailnet login. Nothing about it is special except that it is not the owner. */
const NON_OWNER = "someone-else@reach-transport.test";

/**
 * The identity header this run configures.
 *
 * A test-chosen name, on purpose and visibly so. See the module note: the real
 * `tailscale serve` header has never been captured here, the placeholder pin and
 * its failing test are what hold that gap open, and this suite must not close it
 * by writing a plausible name into a passing test.
 */
const IDENTITY_HEADER = "X-Draht-Reach-Test-Identity";

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];
const children: Bun.Subprocess[] = [];

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. The
 * agent directory therefore lives directly under /tmp.
 */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanupDirs.push(dir);
	return dir;
}

/**
 * Poll until `probe` yields something truthy.
 *
 * The result is awaited, not merely tested: an async probe returns a Promise and
 * a Promise is always truthy, so a version that skipped the await would
 * "succeed" on the first tick of every polling assertion in this file.
 *
 * `what` may be a thunk so that the diagnostic — a child's stderr, the frames
 * that did arrive — is rendered at the moment of the timeout rather than at the
 * moment of the call, when it is still empty.
 */
async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string | (() => string),
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

/** Claim a free loopback port: the gateway CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

// ---------------------------------------------------------------------------
// the TLS front end
// ---------------------------------------------------------------------------

interface Proxy {
	proc: Bun.Subprocess;
	/** `https://127.0.0.1:<port>` — the origin a phone would be handed. */
	origin: string;
	/** PEM the client must trust. Self-signed, generated per run by the fixture. */
	ca: Buffer;
	stdout: { text: string };
	stderr: { text: string };
}

/**
 * Start `scripts/fixtures/tls-proxy.mjs` in front of the daemon.
 *
 * `identity` is `undefined` for the *bare* front end — a proxy that injects no
 * identity header, which is how a forged one is delivered end to end over TLS
 * for clauses 5 and 7. The fixture strips the whole `tailscale-user-` family
 * inbound regardless, and additionally strips whatever header it is told to
 * inject, so the injecting front end cannot be talked into carrying a client's
 * copy.
 */
async function startProxy(options: { target: string; identity?: string; record?: string }): Promise<Proxy> {
	const args = [TLS_PROXY, "--target", options.target, "--port", "0"];
	if (options.identity !== undefined) args.push("--identity-header", options.identity);
	if (options.record !== undefined) args.push("--record", options.record);

	const stdout = { text: "" };
	const stderr = { text: "" };
	const proc = Bun.spawn(["node", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	children.push(proc);
	collect(proc.stdout as ReadableStream<Uint8Array>, stdout);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);

	const listening = await until(
		() => /LISTENING (https:\/\/127\.0\.0\.1:\d+)/.exec(stdout.text),
		() => `the TLS fixture to report a bound origin (stderr: ${stderr.text})`,
	);
	const ca = await until(
		() => /^CA (.+)$/m.exec(stdout.text),
		() => `the TLS fixture to report its CA (stderr: ${stderr.text})`,
	);

	return { proc, origin: listening[1] as string, ca: readFileSync((ca[1] as string).trim()), stdout, stderr };
}

// ---------------------------------------------------------------------------
// HTTPS and wss clients that trust exactly the fixture's CA
// ---------------------------------------------------------------------------

/**
 * `fetch` with a per-connection CA.
 *
 * Bun's `fetch` takes a `tls` option; the cast is because the DOM `RequestInit`
 * this file is typechecked against has no such field. Trusting *this* CA rather
 * than disabling verification matters: `rejectUnauthorized: false` would also
 * have accepted a proxy that was not the one this test started.
 */
function trustingFetch(url: string, init: { headers?: Record<string, string>; ca: Buffer }): Promise<Response> {
	return fetch(url, {
		headers: init.headers ?? {},
		tls: { ca: init.ca },
	} as unknown as RequestInit);
}

interface DialOptions {
	/** Extra request headers on the upgrade. */
	headers?: Record<string, string>;
	/** Query string, including the leading `?`. Only ever used to prove it is ignored. */
	query?: string;
	/** CA to trust; omitted for a plain `ws://` dial straight at the daemon. */
	ca?: Buffer;
}

/** What an upgrade attempt did, without throwing — clause 5 needs the refusal as a value. */
type UpgradeOutcome = "open" | "refused";

function attachUrl(origin: string, options: DialOptions): string {
	return `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/attach${options.query ?? ""}`;
}

function dial(origin: string, options: DialOptions): WebSocket {
	const Ctor = WebSocket as unknown as new (
		url: string,
		opts: { headers: Record<string, string>; tls?: { ca: Buffer } },
	) => WebSocket;
	return new Ctor(attachUrl(origin, options), {
		headers: options.headers ?? {},
		...(options.ca ? { tls: { ca: options.ca } } : {}),
	});
}

/** Attempt an upgrade and report which way it went. Never throws on a refusal. */
async function attemptUpgrade(origin: string, options: DialOptions, timeoutMs = 15_000): Promise<UpgradeOutcome> {
	const ws = dial(origin, options);
	const outcome = await Promise.race([
		new Promise<UpgradeOutcome>((res) => {
			ws.addEventListener("open", () => res("open"));
			ws.addEventListener("error", () => res("refused"));
			ws.addEventListener("close", () => res("refused"));
		}),
		Bun.sleep(timeoutMs).then<UpgradeOutcome>(() => {
			throw new Error(`timed out deciding the upgrade to ${attachUrl(origin, options)}`);
		}),
	]);
	try {
		ws.close();
	} catch {
		// Already gone.
	}
	return outcome;
}

/**
 * One phone on the public wire.
 *
 * Every frame is re-validated against the exported schema on arrival: nothing
 * the daemon emits is trusted here any more than a renderer's bytes are trusted
 * there, and a frame that has drifted must fail this suite rather than be
 * silently reinterpreted by it.
 */
class Phone {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(origin: string, options: DialOptions = {}): Promise<Phone> {
		const ws = dial(origin, options);
		const phone = new Phone(ws);
		await Promise.race([
			new Promise<void>((res, rej) => {
				ws.addEventListener("open", () => res());
				ws.addEventListener("error", () =>
					rej(new Error(`the upgrade to ${attachUrl(origin, options)} was refused`)),
				);
			}),
			Bun.sleep(15_000).then(() => {
				throw new Error(`timed out upgrading to ${attachUrl(origin, options)}`);
			}),
		]);
		return phone;
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	/** `hello` and the `server_hello` it must be answered with, alone. */
	async hello(name: string): Promise<void> {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name, version: "0.0.0" },
		});
		await this.waitFor((frame) => frame.type === "server_hello", "server_hello");
	}

	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs = 15_000,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			() => `${what} (saw: ${this.frames.map((frame) => frame.type).join(", ") || "nothing"})`,
			timeoutMs,
		);
	}

	/**
	 * The `device_credential` this connection earned.
	 *
	 * A refusal ends the wait immediately, with the daemon's own code and
	 * message. Waiting out the full timeout instead would report "the exchange
	 * never completed" — true, and useless — for every distinct reason it can
	 * fail, including the one where the daemon has no device store at all and
	 * said so on the first frame.
	 */
	async credential(): Promise<{ deviceId: string; credential: string }> {
		const frame = await this.waitFor(
			(f) => f.type === "device_credential" || f.type === "protocol_error",
			"device_credential",
		);
		if (frame.type === "protocol_error") {
			throw new Error(`the device exchange was refused: ${frame.code} — ${frame.message}`);
		}
		if (frame.type !== "device_credential") throw new Error("unreachable");
		return { deviceId: frame.deviceId, credential: frame.credential };
	}

	/** The typed refusal this connection was dropped with. */
	async refusal(): Promise<Extract<GeistServerFrame, { type: "protocol_error" }>> {
		const frame = await this.waitFor((f) => f.type === "protocol_error", "a protocol_error");
		if (frame.type !== "protocol_error") throw new Error("unreachable");
		return frame;
	}

	/** Everything the attached session has printed to this connection, in order. */
	output(): string {
		return this.frames
			.filter((frame): frame is Extract<GeistServerFrame, { type: "output" }> => frame.type === "output")
			.map((frame) => frame.data)
			.join("");
	}

	/** Attach to one session. A refusal is reported as itself, for the reason above. */
	async attach(sessionId: string, clientId: string): Promise<void> {
		this.send({ type: "attach", sessionId, clientId, mode: "read-write" });
		const frame = await this.waitFor(
			(f) => f.type === "session_metadata" || f.type === "protocol_error",
			`session_metadata for ${sessionId}`,
		);
		if (frame.type === "protocol_error") {
			throw new Error(`the attach to ${sessionId} was refused: ${frame.code} — ${frame.message}`);
		}
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
// the geist CLI, spawned
// ---------------------------------------------------------------------------

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run the emitted `geist` binary against this run's store.
 *
 * `bun` rather than `node` because `packages/geist/dist/cli.js` imports
 * `@draht/geist-core`, whose package `main` is TypeScript source — the emitted
 * artifact is the file `bin.geist` points at either way, and which runtime
 * loads it is not what any clause here is about.
 */
async function geist(args: string[], timeoutMs = 30_000): Promise<CliResult> {
	const proc = Bun.spawn(["bun", GEIST_CLI, ...args], {
		cwd: REPO_ROOT,
		env: { PATH: process.env.PATH, HOME: home, GEIST_DEVICES_PATH: devicesPath },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	const finished = await Promise.race([
		Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
		Bun.sleep(timeoutMs).then(() => {
			proc.kill("SIGKILL");
			throw new Error(`geist ${args.join(" ")} did not exit within ${timeoutMs}ms`);
		}),
	]);
	const [code, stdout, stderr] = finished;
	return { code, stdout, stderr };
}

/** Mint one single-use bootstrap token by running `geist pair`, as an operator would. */
async function mintBootstrap(): Promise<string> {
	const result = await geist(["pair", "--origin", front.origin]);
	if (result.code !== 0) throw new Error(`geist pair exited ${result.code}\n${result.stderr}`);
	const link = /#token=([A-Za-z0-9_-]+)/.exec(result.stdout);
	if (!link) throw new Error(`geist pair printed no fragment token:\n${result.stdout}`);
	// The whole point of the fragment. A pairing link that ever grows a query
	// string has reintroduced the leak R33-REACH.3 deleted.
	expect(result.stdout).not.toContain("?token=");
	return link[1] as string;
}

// ---------------------------------------------------------------------------
// the draht session
// ---------------------------------------------------------------------------

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

/**
 * Start the emitted draht binary as an attachable session.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print
 * mode and the process would answer once and exit before anything could attach.
 */
async function startDrahtSession(): Promise<DrahtSession> {
	const cwd = tempDir("rtx-cwd-");
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
				// Slow enough that a stream is observably still running while a
				// second socket is refused, fast enough that a reply finishes inside
				// a test.
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
	}, "draht to publish its socket");
	return { proc, id: id.slice(0, -".sock".length), cwd, stderr };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

let agentDir: string;
let home: string;
let devicesPath: string;
let daemonPort: number;
let daemonPid: number;
let daemonStderr: { text: string };
let daemonOrigin: string;
/** The front end that injects the owner's identity — the `tailscale serve` posture. */
let front: Proxy;
/** A front end that injects nothing, so a client's forged header survives the hop. */
let bare: Proxy;
let transcriptPath: string;
let session: DrahtSession;

/** The whole-run listener sample; settled by the final clause. */
let bindWatch: Promise<{ listeners?: Listener[]; error?: unknown }>;
let bindWatchStop: AbortController;

beforeAll(async () => {
	// Both emitted artifacts, rebuilt unconditionally. See the module note on the
	// build state: "it already exists" says nothing about whether it matches this
	// source tree, and a suite that accepts a stale artifact is a suite whose
	// green is not reproducible from the repo.
	for (const pkg of ["coding-agent", "geist"]) {
		const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", pkg) });
		if (build.exitCode !== 0) {
			throw new Error(`${pkg} build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`);
		}
	}
	if (!existsSync(DRAHT_CLI)) throw new Error(`the coding-agent build produced no ${DRAHT_CLI}`);
	if (!existsSync(GEIST_CLI)) throw new Error(`the geist build produced no ${GEIST_CLI}`);

	agentDir = tempDir("rtx-agent-");
	home = tempDir("rtx-home-");
	mkdirSync(join(home, ".geist"), { recursive: true, mode: 0o700 });
	mkdirSync(join(home, ".draht"), { recursive: true, mode: 0o700 });
	devicesPath = join(home, ".geist", "devices.json");

	// The daemon reads this on startup. `tailnet` declares the deployment fronted
	// and names both the owner and — explicitly — the header to read, so nothing
	// in this run depends on the placeholder default that `tailnet-identity.ts`
	// ships while the real name is uncaptured.
	daemonPort = freeLoopbackPort();
	writeFileSync(
		join(home, ".draht", "gateway.config.json"),
		JSON.stringify(
			{
				port: daemonPort,
				host: "127.0.0.1",
				tokens: { default: TOKEN },
				allowedPaths: [home],
				tailnet: { fronted: true, owner: OWNER, header: IDENTITY_HEADER },
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);

	daemonStderr = { text: "" };
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(daemonPort), "--auth", TOKEN], {
		cwd: REPO_ROOT,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			// The daemon and `geist devices` must resolve one file. Set explicitly
			// rather than relying on both deriving it from HOME, so a change to
			// either resolution shows up as a failure here instead of as two
			// daemons quietly disagreeing about who is paired.
			GEIST_DEVICES_PATH: devicesPath,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	daemonPid = daemon.pid;
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(
		() => daemonStderr.text.includes("draht-gateway listening"),
		() => `the daemon to report a bound port (stderr: ${daemonStderr.text})`,
	);
	daemonOrigin = `http://127.0.0.1:${daemonPort}`;

	// Sampling starts before the first request and ends in the last clause, so
	// the bind assertion covers the window rather than an instant inside it.
	bindWatchStop = new AbortController();
	bindWatch = watchListeners(daemonPid, { intervalMs: 25, signal: bindWatchStop.signal }).then(
		(listeners) => ({ listeners }),
		(error: unknown) => ({ error }),
	);

	transcriptPath = join(home, "front-transcript.ndjson");
	front = await startProxy({
		target: daemonOrigin,
		identity: `${IDENTITY_HEADER}:${OWNER}`,
		record: transcriptPath,
	});
	bare = await startProxy({ target: daemonOrigin });

	session = await startDrahtSession();
}, 600_000);

afterAll(async () => {
	bindWatchStop?.abort();
	try {
		await bindWatch;
	} catch {
		// The final clause is where a watcher failure is reported.
	}
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 — the credential is a first message, never a query string (R33-REACH.3)
// ---------------------------------------------------------------------------

test("a wss client presenting ?token=<valid> is refused and the same credential presented as a first message is accepted", async () => {
	const bootstrap = await mintBootstrap();

	// The query string carries a *genuinely valid* secret. That is the whole
	// point: this must be refused because of where it was presented, not because
	// of what it was. A test that put a wrong token in the query would pass
	// against a daemon that still read the query.
	const inQuery = await Phone.open(front.origin, { ca: front.ca, query: `?token=${bootstrap}` });
	await inQuery.hello("query-credential");

	// `server_hello` and nothing else. The fleet listing is session data, and a
	// connection that has not authenticated is not told a session exists.
	expect(inQuery.frames.map((frame) => frame.type)).toEqual(["server_hello"]);

	// The frame that would dial `<id>.sock`, naming a session that really is live.
	inQuery.send({ type: "attach", sessionId: session.id, clientId: "query-credential", mode: "read-write" });
	expect(await inQuery.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(await until(() => inQuery.closed, "the query-credential connection to be dropped")).toMatchObject({
		code: 1008,
	});
	inQuery.close();

	// The same secret, one layer in. Still spendable — the refusal above must not
	// have consumed it, which is also what makes this half meaningful.
	const asMessage = await Phone.open(front.origin, { ca: front.ca });
	await asMessage.hello("first-message-credential");
	asMessage.send({
		type: "pair_device",
		bootstrapToken: bootstrap,
		device: { name: "oskar's phone", platform: "ios" },
	});
	const issued = await asMessage.credential();
	expect(issued.deviceId).toMatch(/^dev_/);
	expect(issued.credential).not.toBe(bootstrap);

	// It is a real authorization, not a frame that merely looks like one: the
	// session opens for it.
	await asMessage.attach(session.id, "first-message-credential");
	asMessage.send({ type: "input", data: "hello from the first message", clientId: "first-message-credential" });
	await asMessage.waitFor(
		() => asMessage.output().includes("stub: hello from the first message"),
		"the streamed reply to the paired device",
		40_000,
	);
	asMessage.close();
}, 120_000);

// ---------------------------------------------------------------------------
// 2 — one bootstrap, one device (R33-REACH.5, R33-REACH.7)
// ---------------------------------------------------------------------------

test("a bootstrap token is accepted exactly once, its replay refused, and the first connection stays bound and streaming throughout", async () => {
	const bootstrap = await mintBootstrap();

	const first = await Phone.open(front.origin, { ca: front.ca });
	await first.hello("first-exchange");
	first.send({ type: "pair_device", bootstrapToken: bootstrap, device: { name: "first phone", platform: "ios" } });
	const bound = await first.credential();
	await first.attach(session.id, "first-exchange");

	// Genuinely mid-stream when the replay lands: the prompt is long enough that
	// the stub is still emitting, so "kept streaming" is a claim about frames
	// minted after the refusal, not about frames that had already arrived.
	const prompt = "the first prompt is deliberately long so that the stream is still running when the replay lands";
	first.send({ type: "input", data: prompt, clientId: "first-exchange" });
	await first.waitFor((frame) => frame.type === "output", "the first device's stream to start", 40_000);
	const framesBeforeReplay = first.frames.length;

	const replay = await Phone.open(front.origin, { ca: front.ca });
	await replay.hello("replaying-phone");
	replay.send({ type: "pair_device", bootstrapToken: bootstrap, device: { name: "thief", platform: "android" } });
	expect(await replay.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(await until(() => replay.closed, "the replaying connection to be dropped")).toMatchObject({ code: 1008 });
	expect(replay.frames.some((frame) => frame.type === "device_credential")).toBe(false);
	replay.close();

	// The bound device is untouched: no refusal, still open, and receiving output
	// minted after the replay was refused.
	expect(first.closed).toBeNull();
	expect(first.frames.some((frame) => frame.type === "protocol_error")).toBe(false);
	await until(() => first.frames.length > framesBeforeReplay, "output minted after the replay was refused", 40_000);
	await first.waitFor(() => first.output().includes(`stub: ${prompt}`), "the first device's whole reply", 60_000);

	// The store's own account: exactly one device came out of that token.
	const listed = await geist(["devices", "list"]);
	expect(listed.code).toBe(0);
	expect(listed.stdout).toContain(bound.deviceId);
	expect(listed.stdout).not.toContain("thief");
	first.close();
}, 180_000);

// ---------------------------------------------------------------------------
// 3 — pairing is socket-scoped (R33-REACH.7, GSEC-08)
// ---------------------------------------------------------------------------

test("a wrong-token pair on a second socket leaves the first device authorized and undisturbed", async () => {
	const bootstrap = await mintBootstrap();
	const holder = await Phone.open(front.origin, { ca: front.ca });
	await holder.hello("holder");
	holder.send({ type: "pair_device", bootstrapToken: bootstrap, device: { name: "holder", platform: "ios" } });
	const held = await holder.credential();
	await holder.attach(session.id, "holder");

	const intruder = await Phone.open(front.origin, { ca: front.ca });
	await intruder.hello("intruder");
	intruder.send({
		type: "pair_device",
		bootstrapToken: `${bootstrap}-but-wrong`,
		device: { name: "intruder", platform: "android" },
	});
	expect(await intruder.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(await until(() => intruder.closed, "the wrong-token connection to be dropped")).toMatchObject({ code: 1008 });
	intruder.close();

	// Undisturbed is the claim, so it is measured on the holder rather than on
	// the intruder: still open, never refused, and still able to drive the
	// session it attached to.
	expect(holder.closed).toBeNull();
	expect(holder.frames.some((frame) => frame.type === "protocol_error")).toBe(false);
	holder.send({ type: "input", data: "still authorized", clientId: "holder" });
	await holder.waitFor(() => holder.output().includes("stub: still authorized"), "the holder's reply", 40_000);

	// …and the store did not acquire the intruder's device either.
	const listed = await geist(["devices", "list"]);
	expect(listed.stdout).toContain(held.deviceId);
	expect(listed.stdout).not.toContain("intruder");
	holder.close();
}, 180_000);

// ---------------------------------------------------------------------------
// 4 — revocation reaches the next frame (R33-REACH.6)
// ---------------------------------------------------------------------------

test("geist devices revoke makes the next frame from that device refused", async () => {
	const bootstrap = await mintBootstrap();
	const doomed = await Phone.open(front.origin, { ca: front.ca });
	await doomed.hello("doomed");
	doomed.send({ type: "pair_device", bootstrapToken: bootstrap, device: { name: "lost phone", platform: "ios" } });
	const credential = await doomed.credential();
	await doomed.attach(session.id, "doomed");

	// The revocation is performed by another process against the same file —
	// which is exactly what `geist devices revoke` is to a running daemon.
	const revoked = await geist(["devices", "revoke", credential.deviceId]);
	expect(revoked.code).toBe(0);
	expect(revoked.stdout).toContain(`revoked ${credential.deviceId}`);

	// The next frame from that device. Refused before it can reach the session.
	doomed.send({ type: "input", data: "rm -rf /\n", clientId: "doomed" });
	expect(await doomed.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(await until(() => doomed.closed, "the revoked connection to be dropped")).toMatchObject({ code: 1008 });
	// The refusal says nothing about which device it was: this frame reaches a
	// phone somebody else may be holding. Scoped to the refusal deliberately —
	// this device's history necessarily contains its own `device_credential`,
	// because that frame is how the daemon delivered the credential in the first
	// place. Asserting over the whole history would only prove the wire works.
	const refusals = doomed.frames.filter((frame) => frame.type === "protocol_error");
	expect(refusals.length).toBeGreaterThan(0);
	expect(JSON.stringify(refusals)).not.toContain(credential.credential);
	expect(JSON.stringify(refusals)).not.toContain(credential.deviceId);
	doomed.close();

	// And it cannot be laundered back into service by reconnecting.
	const again = await Phone.open(front.origin, { ca: front.ca });
	await again.hello("doomed-again");
	again.send({ type: "authenticate", deviceId: credential.deviceId, credential: credential.credential });
	expect(await again.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	again.close();

	const listed = await geist(["devices", "list"]);
	expect(listed.stdout).toMatch(new RegExp(`${credential.deviceId}\\s+revoked`));
}, 180_000);

// ---------------------------------------------------------------------------
// 5 — a forged identity header naming a non-owner is refused (R33-REACH.8)
// ---------------------------------------------------------------------------

test("a forged identity header naming a non-owner is refused", async () => {
	const forged = { [IDENTITY_HEADER]: NON_OWNER, Authorization: `Bearer ${TOKEN}` };

	// Over TLS through a front end that injects nothing, so the client's own
	// header really does reach the daemon — and directly on loopback, which is
	// what a process on this machine can do whatever any proxy does.
	expect((await trustingFetch(`${bare.origin}/fleet`, { headers: forged, ca: bare.ca })).status).toBe(403);
	expect((await fetch(`${daemonOrigin}/fleet`, { headers: forged })).status).toBe(403);

	// Refused before a route is matched, so a refusal reveals no route: /health
	// is public and still 403s.
	expect((await fetch(`${daemonOrigin}/health`, { headers: forged })).status).toBe(403);

	// And the upgrade itself, which is where a credential would have gone.
	expect(await attemptUpgrade(bare.origin, { headers: forged, ca: bare.ca })).toBe("refused");
	expect(await attemptUpgrade(daemonOrigin, { headers: forged })).toBe("refused");

	// The injecting front end additionally overwrites a forged copy rather than
	// forwarding two — the fixture strips the header it is told to inject, so a
	// client cannot smuggle one past it. Supporting evidence for the topology,
	// not a substitute for the refusals above: the daemon must refuse whether or
	// not any proxy is well-behaved.
	const throughFront = await trustingFetch(`${front.origin}/fleet`, {
		headers: { [IDENTITY_HEADER]: NON_OWNER, Authorization: `Bearer ${TOKEN}` },
		ca: front.ca,
	});
	expect(throughFront.status).toBe(200);
}, 60_000);

// ---------------------------------------------------------------------------
// 6 — absence never grants (R33-REACH.8)
// ---------------------------------------------------------------------------

test("a request with no identity header is still subject to full credential auth", async () => {
	// No identity header anywhere in these requests: the bare front end injects
	// none and the client sends none.
	expect((await trustingFetch(`${bare.origin}/fleet`, { ca: bare.ca })).status).toBe(401);
	expect(
		(await trustingFetch(`${bare.origin}/fleet`, { headers: { Authorization: "Bearer wrong" }, ca: bare.ca })).status,
	).toBe(401);
	expect((await fetch(`${daemonOrigin}/fleet`)).status).toBe(401);

	// The credential check is what decides, and it still decides both ways.
	expect(
		(await trustingFetch(`${bare.origin}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` }, ca: bare.ca }))
			.status,
	).toBe(200);

	// On `/attach` the same absence lands one layer in: the upgrade succeeds
	// because a device's credential is a frame, and then the wire refuses.
	const anonymous = await Phone.open(bare.origin, { ca: bare.ca });
	await anonymous.hello("no-identity-header");
	expect(anonymous.frames.map((frame) => frame.type)).toEqual(["server_hello"]);
	anonymous.send({ type: "attach", sessionId: session.id, clientId: "no-identity-header", mode: "read-write" });
	expect(await anonymous.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	anonymous.close();
}, 60_000);

// ---------------------------------------------------------------------------
// 7 — the header is never the only check (R33-REACH.8)
// ---------------------------------------------------------------------------

test("a forged identity header naming the owner is refused with no credential and again with an invalid one", async () => {
	// The case a local process actually produces: it cannot name a non-owner and
	// get anywhere, so it names the owner. If the header were treated as a
	// credential — or as a reason to skip one — this is the request that would
	// walk in. Delivered straight at the loopback listener, which is what a
	// process on this box can do regardless of what fronts the daemon.
	const asOwner = { [IDENTITY_HEADER]: OWNER };

	// No credential at all.
	expect((await fetch(`${daemonOrigin}/fleet`, { headers: asOwner })).status).toBe(401);
	expect((await trustingFetch(`${bare.origin}/fleet`, { headers: asOwner, ca: bare.ca })).status).toBe(401);

	// An invalid one.
	const invalid = { ...asOwner, Authorization: "Bearer not-the-operator-token" };
	expect((await fetch(`${daemonOrigin}/fleet`, { headers: invalid })).status).toBe(401);
	expect((await trustingFetch(`${bare.origin}/fleet`, { headers: invalid, ca: bare.ca })).status).toBe(401);

	// And on the wire, where a device credential lives. Owner-named header, no
	// credential: the bridge still refuses.
	const bare401 = await Phone.open(daemonOrigin, { headers: asOwner });
	await bare401.hello("owner-header-no-credential");
	bare401.send({ type: "attach", sessionId: session.id, clientId: "owner-header-no-credential", mode: "read-write" });
	expect(await bare401.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	bare401.close();

	// Owner-named header plus a well-formed but invalid device credential on the
	// upgrade: refused at `hello`, having spent this connection's one attempt.
	const forgedCredential = await Phone.open(daemonOrigin, {
		headers: { ...asOwner, Authorization: "Bearer dev_deadbeefdeadbeef:not-a-real-credential" },
	});
	// Deliberately NOT `hello()`: that helper awaits `server_hello`, and a
	// credential presented on the upgrade is verified BEFORE the handshake is
	// answered, so this connection is refused without ever seeing one. Awaiting
	// it here would hang and then read as a product failure — the refusal
	// arriving early is the designed behaviour, not a missing greeting.
	forgedCredential.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "owner-header-invalid-credential", version: "0.0.0" },
	});
	expect(await forgedCredential.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(forgedCredential.frames.some((frame) => frame.type === "server_hello")).toBe(false);
	expect(forgedCredential.frames.some((frame) => frame.type === "session_metadata")).toBe(false);
	forgedCredential.close();
}, 60_000);

// ---------------------------------------------------------------------------
// 8 — a rotated-away credential is theft, not error (R33-REACH.5, GSEC-04)
// ---------------------------------------------------------------------------

test("a rotated-away predecessor credential presented after rotation is refused and surfaces a reuse event", async () => {
	const bootstrap = await mintBootstrap();
	const paired = await Phone.open(front.origin, { ca: front.ca });
	await paired.hello("rotating-phone");
	paired.send({ type: "pair_device", bootstrapToken: bootstrap, device: { name: "rotating", platform: "ios" } });
	const first = await paired.credential();
	paired.close();

	// A reconnect rotates: the value the phone stores after this is not the value
	// it stored before it.
	const reconnected = await Phone.open(front.origin, { ca: front.ca });
	await reconnected.hello("rotating-phone-again");
	reconnected.send({ type: "authenticate", deviceId: first.deviceId, credential: first.credential });
	const second = await reconnected.credential();
	expect(second.deviceId).toBe(first.deviceId);
	expect(second.credential).not.toBe(first.credential);

	const stderrBefore = daemonStderr.text.length;

	// The predecessor, presented after the rotation that retired it. Whoever
	// holds this observed a credential that is no longer in force — which is a
	// theft signal, not a typo, and is the distinction GSEC-04 asked for.
	const thief = await Phone.open(front.origin, { ca: front.ca });
	await thief.hello("thief");
	thief.send({ type: "authenticate", deviceId: first.deviceId, credential: first.credential });
	expect(await thief.refusal()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect(await until(() => thief.closed, "the predecessor-credential connection to be dropped")).toMatchObject({
		code: 1008,
	});
	thief.close();

	// The daemon says so where an operator can see it, naming the device and
	// carrying no credential material.
	const logged = await until(
		() => {
			const since = daemonStderr.text.slice(stderrBefore);
			return since.includes("credential_reuse") ? since : undefined;
		},
		() => `a credential_reuse record on the daemon's log (saw: ${daemonStderr.text.slice(stderrBefore)})`,
	);
	expect(logged).toContain(first.deviceId);
	expect(logged).not.toContain(first.credential);
	expect(logged).not.toContain(second.credential);

	// The legitimate device is untouched by the theft attempt.
	expect(reconnected.closed).toBeNull();
	reconnected.close();
}, 180_000);

// ---------------------------------------------------------------------------
// the bind, for the whole run
// ---------------------------------------------------------------------------

test("the daemon bound nothing but loopback for the whole run", async () => {
	bindWatchStop.abort();
	const settled = await bindWatch;
	// A watcher that could not see the process must fail this clause, not pass
	// it. `listeningSockets` throws rather than returning `[]` when `lsof` is
	// missing or refused the query, precisely so "no listeners observed" cannot
	// mean "nothing could be observed" (P33-T16).
	if (settled.listeners === undefined) throw settled.error;
	const listeners = settled.listeners;

	// Non-vacuity: the daemon really was listening, and on the port every clause
	// above went through.
	expect(listeners.length).toBeGreaterThan(0);
	expect(listeners.some((listener) => listener.port === daemonPort)).toBe(true);

	const offBox = listeners.filter((listener) => !isLoopbackListener(listener));
	expect(offBox.length === 0 ? "loopback only" : `non-loopback listeners: ${describeListeners(offBox)}`).toBe(
		"loopback only",
	);
}, 30_000);
