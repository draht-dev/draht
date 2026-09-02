/**
 * Emitted-process proofs for the loopback-by-default posture (R32-FLEET.10).
 *
 * The requirement names four sites — the CLI flag, the config file, the
 * programmatic surface and the individual request — and a package-level test
 * satisfies none of them: `parseArgs(...)`, `createServer(...)` and a hand-built
 * `requestIP` stub all pass in a process that never binds anything. The CLI-flag
 * site is covered by "cli end-to-end refusal" in bind-host-library.test.ts; the
 * other three are covered here, each by a real second process:
 *
 *   • config file  — `bun src/cli.ts` with the host coming ONLY from
 *                    `$HOME/.draht/gateway.config.json`, no `--host` argument;
 *   • programmatic — a separate process that imports the shipped module and
 *                    calls `createServer` / `startGateway` itself;
 *   • per request  — a separate process that imports the shipped module, ignores
 *                    the vetted hostname and binds every interface with its own
 *                    `Bun.serve`, then really is dialled from a non-loopback
 *                    address (this host's own LAN IPv4).
 *
 * Every assertion below is made from outside the process under test: over HTTP,
 * over the child's stderr, or over `lsof`'s view of its sockets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describeListeners, type Listener, watchListeners } from "./helpers/listening-sockets";

const GATEWAY_SRC = join(import.meta.dir, "..");
const CLI = join(GATEWAY_SRC, "cli.ts");
const INDEX = join(GATEWAY_SRC, "index.ts");
const REFUSAL = "Refusing to bind non-loopback host '0.0.0.0'.";

const cleanupDirs: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

/** Claim a currently-free loopback port; the CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** First non-internal IPv4 address of this host, or null when the box has none. */
function externalIPv4(): string | null {
	for (const iface of Object.values(networkInterfaces())) {
		for (const entry of iface ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

/**
 * Watch `pid`'s listening sockets for as long as `body` runs, and hand back every
 * distinct one the kernel showed.
 *
 * Enumeration lives in `helpers/listening-sockets.ts`, which throws rather than
 * returning an empty list when it cannot see the process at all — the Phase 32
 * residual was a single `lsof` sample that read its own unavailability as "this
 * daemon is listening on nothing". The rejection is settled into a value here
 * because the watcher can fail while `body` is still running.
 */
async function listenersDuring(pid: number, body: () => Promise<void>): Promise<Listener[]> {
	const controller = new AbortController();
	const watching = watchListeners(pid, { intervalMs: 25, signal: controller.signal }).then(
		(listeners) => ({ listeners, error: undefined as unknown }),
		(error: unknown) => ({ listeners: undefined, error }),
	);
	try {
		await body();
	} finally {
		controller.abort();
	}
	const settled = await watching;
	if (settled.listeners === undefined) throw settled.error;
	return settled.listeners;
}

/** Write a script into a temp dir and spawn it with `bun`, capturing both pipes. */
function spawnScript(source: string): { proc: Bun.Subprocess<"ignore", "pipe", "pipe">; dir: string } {
	const dir = tempDir("draht-gateway-embed-");
	const file = join(dir, "embedder.ts");
	writeFileSync(file, source);
	const proc = Bun.spawn([process.execPath, file], {
		env: { ...process.env, HOME: dir },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	}) as Bun.Subprocess<"ignore", "pipe", "pipe">;
	children.push(proc);
	return { proc, dir };
}

/** Read the child's stdout until a line parses as JSON, or it dies trying. */
async function firstJsonLine<T>(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs = 20_000): Promise<T> {
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffered = "";
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			for (const line of buffered.split("\n")) {
				if (!line.trim().startsWith("{")) continue;
				try {
					return JSON.parse(line) as T;
				} catch {
					// Partial line — wait for the rest.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	const stderr = await new Response(proc.stderr).text();
	throw new Error(`child never printed a JSON line.\nstdout so far:\n${buffered}\nstderr:\n${stderr}`);
}

describe("the config-file site — a spawned daemon, host only from gateway.config.json", () => {
	test("refuses, exits 1, and leaves the port unbound", async () => {
		const home = tempDir("draht-gateway-cfg-");
		mkdirSync(join(home, ".draht"), { recursive: true });
		writeFileSync(
			join(home, ".draht", "gateway.config.json"),
			JSON.stringify({ host: "0.0.0.0", tokens: { default: "config-file-token" } }),
			{ mode: 0o600 },
		);
		const port = freeLoopbackPort();

		// No --host: the only place "0.0.0.0" exists is the config file.
		const proc = Bun.spawn([process.execPath, CLI, "--port", String(port)], {
			env: { ...process.env, HOME: home },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		const code = await proc.exited;

		expect({ code, refused: stderr.includes(REFUSAL) }).toEqual({ code: 1, refused: true });
		// An operator error, not a crash.
		expect(stderr).not.toContain("at <anonymous>");

		// Nothing was ever bound: the port is still free for us to take.
		const after = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("free") });
		try {
			expect(after.port).toBe(port);
		} finally {
			after.stop(true);
		}
	}, 30_000);

	test("a loopback config-file host on the same daemon does start and serve", async () => {
		const home = tempDir("draht-gateway-cfg-ok-");
		mkdirSync(join(home, ".draht"), { recursive: true });
		writeFileSync(
			join(home, ".draht", "gateway.config.json"),
			JSON.stringify({ host: "127.0.0.1", tokens: { default: "config-file-token" } }),
			{ mode: 0o600 },
		);
		const port = freeLoopbackPort();

		const proc = Bun.spawn([process.execPath, CLI, "--port", String(port)], {
			env: { ...process.env, HOME: home },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		}) as Bun.Subprocess<"ignore", "ignore", "pipe">;
		children.push(proc);

		let health: Response | undefined;
		const observed = await listenersDuring(proc.pid as number, async () => {
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline && !health) {
				try {
					health = await fetch(`http://127.0.0.1:${port}/health`);
				} catch {
					await Bun.sleep(50);
				}
			}
			// Keep watching past the first successful request: a daemon that binds
			// loopback and widens a moment later would pass a one-shot sample.
			for (let i = 0; i < 4; i++) {
				expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
				await Bun.sleep(50);
			}
		});
		expect(health?.status).toBe(200);

		// The acceptance clause in full: 127.0.0.1 for the whole run, and nothing
		// else — including nothing that only appeared after the daemon warmed up.
		expect(describeListeners(observed)).toBe(`127.0.0.1:${port}`);
	}, 30_000);
});

describe("the programmatic site — a separate process that imports the shipped module", () => {
	test("createServer and startGateway both refuse, and the process opens no socket", async () => {
		const port = freeLoopbackPort();
		const { proc } = spawnScript(`
			import { createServer, startGateway } from ${JSON.stringify(INDEX)};

			const attempt = (fn) => {
				try {
					fn();
					return "no-throw";
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			};

			const result = {
				createServer: attempt(() => createServer({ port: ${port}, authToken: "t", host: "0.0.0.0" })),
				startGateway: attempt(() => startGateway({ port: ${port}, authToken: "t", host: "0.0.0.0" })),
				fromSettings: attempt(() =>
					startGateway({
						port: ${port},
						authToken: "t",
						config: {
							port: ${port},
							host: "0.0.0.0",
							tokens: { default: "t" },
							allowedPaths: ["~/"],
							maxSessions: 100,
							idleTimeout: 255,
						},
					}),
				),
			};
			console.log(JSON.stringify(result));
			// Stay alive so the parent can look at this pid's sockets.
			await Bun.sleep(15000);
		`);

		// The refusal happened before any listener existed, and no listener appears
		// later either — asserted on the kernel's view of the process for the whole
		// run, not on the return value of the call and not at one sampled instant.
		let result: Record<string, string> | undefined;
		const observed = await listenersDuring(proc.pid as number, async () => {
			result = await firstJsonLine<Record<string, string>>(proc);
			await Bun.sleep(200);
		});

		for (const [site, message] of Object.entries(result ?? {})) {
			expect({ site, refused: message.includes(REFUSAL) }).toEqual({ site, refused: true });
		}
		expect(Object.keys(result ?? {})).toEqual(["createServer", "startGateway", "fromSettings"]);
		expect(describeListeners(observed)).toBe("(none)");

		// And the port really is still free.
		const after = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("free") });
		try {
			expect(after.port).toBe(port);
		} finally {
			after.stop(true);
		}
	}, 30_000);
});

describe("the per-request site — a real off-box dial into an embedder that bound every interface", () => {
	const lan = externalIPv4();

	test.skipIf(lan === null)(
		"a request from a non-loopback peer is refused 403 while a loopback peer is served",
		async () => {
			const port = freeLoopbackPort();
			const { proc } = spawnScript(`
				import { createServer } from ${JSON.stringify(INDEX)};

				// The embedder ignores the vetted hostname (127.0.0.1) and binds every
				// interface itself — exactly the route-around the per-request guard exists
				// for. No allowNonLoopback anywhere.
				const { app, websocket } = createServer({ port: ${port}, authToken: "per-request-token" });
				const server = Bun.serve({ port: ${port}, hostname: "0.0.0.0", fetch: app.fetch, websocket });
				console.log(JSON.stringify({ ready: true, port: server.port }));
				await new Promise(() => {});
			`);

			expect(await firstJsonLine<{ ready: boolean }>(proc)).toMatchObject({ ready: true });

			const loopback = await fetch(`http://127.0.0.1:${port}/health`);
			expect(loopback.status).toBe(200);

			// The same server, dialled at this host's routable address: the peer the
			// kernel reports is the LAN address, which is not provably on this box.
			const offBox = await fetch(`http://${lan}:${port}/health`);
			expect(offBox.status).toBe(403);
			expect((await offBox.json()) as { error: string }).toEqual({
				error: "Forbidden: gateway is bound loopback-only",
			});

			// The refusal is logged once, for the operator, with remediation.
			await Bun.sleep(100);
			const secondOffBox = await fetch(`http://${lan}:${port}/health`);
			expect(secondOffBox.status).toBe(403);
		},
		45_000,
	);

	test("the address the off-box proof dials is genuinely off-box", () => {
		// The fixture check for the proof above, and a loud record when this host
		// cannot run it at all — a silently skipped proof is not evidence either.
		if (lan === null) {
			console.warn("SKIPPED the off-box per-request proof: this host has no non-internal IPv4 interface.");
			return;
		}
		expect(lan.startsWith("127.")).toBe(false);
	});
});
