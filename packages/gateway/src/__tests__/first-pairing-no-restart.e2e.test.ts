/**
 * FIX-4 — the very first `geist pair` on a machine reaches the daemon that is
 * already running.
 *
 * Phase 33's Goal (`.planning/ROADMAP.md:196`) is one continuous act: Oskar
 * opens the MagicDNS URL on his iPhone, scans a QR once, and steers a live
 * session. Nothing in that sentence contains a daemon restart, and a first
 * pairing that needs one is not the goal delivered late — it is the goal not
 * delivered, because the operator has to know to go back to the machine the
 * phone exists to replace.
 *
 * What made it fail was where the posture was decided. `createServer` read its
 * `devices` option **once**, when the routes were built, so `/attach`'s
 * authority was chosen at process start; on a fresh machine there is no store
 * yet, so the choice was "no device exchange" and it stayed that way for the
 * life of the process. `geist pair` would then mint a perfectly good bootstrap
 * token into a store that the running daemon had already decided not to have.
 *
 * ## Why this test spawns things instead of importing them
 *
 * Every process here is a real one and none of them is imported:
 *
 *   • the daemon, started by its own bin (`bun packages/gateway/src/cli.ts`) on
 *     an ephemeral loopback port, with a throwaway `$HOME` and — the whole
 *     point — **no `GEIST_DEVICES_PATH`**, which is the shipped configuration
 *     of a machine that has never paired anything;
 *   • `geist pair`, run afterwards as the separate process an operator runs,
 *     against that same `$HOME`, so the store appears underneath a daemon that
 *     is already serving.
 *
 * `reach-transport.e2e.test.ts` sets `GEIST_DEVICES_PATH` in its `beforeAll`,
 * which is exactly why nine passing device tests never noticed: an
 * environment-configured daemon takes the device posture at startup and the
 * first-run path is the one no test walked. So this file refuses that variable
 * on purpose, and asserts the daemon's pid is unchanged at the moment the phone
 * is issued its credential — a restart would satisfy every other assertion here.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const GEIST_CLI = join(REPO_ROOT, "packages", "geist", "src", "cli.ts");
const TOKEN = "first-pairing-no-restart-operator-token";

/** `geist pair` will not touch a tailnet for a test; this stands in for the published origin. */
const ORIGIN = "https://phone-pairing.test";

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

/** Unix socket paths are capped near 104 bytes and macOS's tmpdir is already long. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

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
	// Evaluated only on failure: the useful description is usually a snapshot of
	// something that has been accumulating while the probe waited.
	throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

/** Claim a free loopback port: the CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/**
 * One renderer on `/attach`, driven the way a phone drives it.
 *
 * The `headers` option is what separates the two clients this file needs: the
 * operator, who carries the shared token on the upgrade request, and the phone,
 * which carries nothing at all because all it has is a bootstrap token it read
 * off a QR — a value that may only ever travel in a frame.
 */
class Renderer {
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

	static async open(base: string, headers: Record<string, string> = {}): Promise<Renderer> {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${base}/attach`, { headers });
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

	hello(): void {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "first-pairing-e2e", version: "0.0.0" },
		});
	}

	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs = 20_000,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			// A refusal is a `protocol_error` followed immediately by a policy
			// close, and the close can outrun the frame — so the close code is
			// part of the diagnosis, not a footnote to it.
			() =>
				`${what} (saw: ${this.frames.map((f) => `${f.type}${f.type === "protocol_error" ? `/${f.code}` : ""}`).join(", ") || "nothing"}; closed: ${this.closed === null ? "no" : `${this.closed.code} ${this.closed.reason}`})`,
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

let home: string;
let agentDir: string;
let devicesPath: string;
let base: string;
let daemonPid: number;
let daemonStderr: { text: string };
/** The operator's connection, opened before pairing and deliberately kept open across it. */
let operator: Renderer;

beforeAll(async () => {
	home = tempDir("fpr-home-");
	agentDir = tempDir("fpr-agent-");
	devicesPath = join(home, ".geist", "devices.json");

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		cwd: REPO_ROOT,
		// Built from nothing rather than spread from this process's environment:
		// a `GEIST_DEVICES_PATH` inherited from a developer's shell would hand the
		// daemon the store at startup and quietly restore the very posture whose
		// absence this file exists to test.
		env: {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
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

	base = `ws://127.0.0.1:${port}`;
}, 120_000);

afterAll(() => {
	operator?.close();
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

test("the fresh daemon started with no store at all, and says so without telling anyone to restart", () => {
	expect(existsSync(devicesPath)).toBe(false);

	// The startup notice an operator reads on a machine that has never paired.
	// It must describe the posture and the next command — and nothing else: a
	// restart clause here is a promise this file exists to make false.
	const warning = daemonStderr.text
		.split("\n")
		.filter((line) => line.includes("no device store"))
		.join("\n");
	expect(warning).toContain("operator token");
	expect(warning).toContain("geist pair");
	expect(warning).not.toContain("restart");
	// Operator-facing text carries no finding ids (REQUIREMENTS.md:225).
	expect(warning).not.toMatch(/R33-REACH\.\d/);
});

test("before anything is paired, the operator token still attaches", async () => {
	operator = await Renderer.open(base, { Authorization: `Bearer ${TOKEN}` });
	operator.hello();

	// The fleet is session data: the bridge emits it only to a connection that
	// is somebody. Receiving it is the proof that the host vouched for this one.
	await operator.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	expect(operator.closed).toBeNull();
});

test("`geist pair` writes the store underneath the running daemon", async () => {
	const stdout = await runPair();
	expect(existsSync(devicesPath)).toBe(true);
	expect(stdout).toContain(`${ORIGIN}/ui#token=`);
});

test("a phone redeems that first bootstrap on the daemon that never restarted", async () => {
	// A second `geist pair`, so this clause owns the token it spends: the
	// bootstrap is single-use and the clause above already printed one.
	const token = bootstrapFrom(await runPair());

	// No Authorization header, because a phone that has just scanned a QR has no
	// operator token — it has a bootstrap value, and the only place that value
	// is allowed to travel is a frame (R33-REACH.3).
	const phone = await Renderer.open(base, {});
	try {
		phone.hello();
		await phone.waitFor((frame) => frame.type === "server_hello", "server_hello");
		phone.send({
			type: "pair_device",
			bootstrapToken: token,
			device: { name: "oskar's iphone", platform: "ios" },
		});

		const issued = await phone.waitFor((frame) => frame.type === "device_credential", "the issued device credential");
		if (issued.type !== "device_credential") throw new Error("unreachable: the predicate matched another frame");
		expect(issued.deviceId).toMatch(/^dev_/);
		expect(issued.credential).not.toBe(token);
		// And it is now somebody: the fleet follows the credential on the same connection.
		await phone.waitFor((frame) => frame.type === "fleet", "the fleet frame after pairing");

		// The assertion that makes every other one above mean something. A daemon
		// restarted between `geist pair` and this connection would have issued
		// this credential too — and would have been the bug.
		expect(daemonPid).toBe(children[0].pid);
		expect(children[0].exitCode).toBeNull();
	} finally {
		phone.close();
	}
}, 60_000);

test("the operator connection opened before pairing keeps the posture it was admitted under", async () => {
	// Authority is chosen per connection, not per process, so a store appearing
	// mid-flight does not retroactively unauthenticate a connection the host
	// already vouched for. Asked for a session that does not exist, this one is
	// refused as `unknown_session` — the answer given to somebody. A connection
	// that had lost its posture would be refused as `not_authenticated` instead.
	operator.send({ type: "attach", sessionId: "no-such-session", clientId: "operator", mode: "read-write" });
	const refusal = await operator.waitFor((frame) => frame.type === "protocol_error", "the refusal");
	if (refusal.type !== "protocol_error") throw new Error("unreachable: the predicate matched another frame");
	expect(refusal.code).toBe("unknown_session");
});

/** Run the real `geist pair`, as the separate process an operator runs, against the daemon's HOME. */
async function runPair(): Promise<string> {
	const proc = Bun.spawn(["bun", GEIST_CLI, "pair", "--origin", ORIGIN, "--ttl", "300"], {
		cwd: REPO_ROOT,
		env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`geist pair exited ${code}:\n${stderr}`);
	return stdout;
}

/** The bootstrap token as a phone reads it: out of the fragment of the printed link. */
function bootstrapFrom(stdout: string): string {
	const match = /#token=([A-Za-z0-9._-]+)/.exec(stdout);
	if (!match) throw new Error(`geist pair printed no pairing link:\n${stdout}`);
	return match[1] as string;
}
