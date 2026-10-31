// The fixtures and the daemon harness the class-3 spawn suites stand on. Each is shown to do its job and, where a silent
// failure would let a suite pass vacuously, to fail loudly instead.

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type GeistConfig, loadGeistConfigFile, RegistryFileRefusedError } from "@draht/geist-protocol";
import { argvOf, cwdOf, envOf, isProcessAlive, psRows, rowFor, uniqueMarker } from "./helpers/process-table.js";
import {
	AttachClient,
	DaemonStartError,
	descendantPids,
	type EmittedDaemon,
	jsFixture,
	shortBase,
	shTripwire,
	startEmittedDaemon,
	writeRegistry,
} from "./helpers/spawn-daemon.js";

const BUN = process.execPath;
const GATEWAY_CLI = resolve(import.meta.dir, "..", "cli.ts");

const bases: string[] = [];
const daemons: EmittedDaemon[] = [];
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
const children: Bun.Subprocess[] = [];

function base(prefix = "w5h-"): string {
	const dir = shortBase(prefix);
	bases.push(dir);
	return dir;
}

afterAll(async () => {
	for (const daemon of daemons) {
		try {
			await daemon.dispose();
		} catch {
			try {
				process.kill(daemon.pid, "SIGKILL");
			} catch {}
		}
	}
	for (const child of children) child.kill("SIGKILL");
	for (const server of servers) server.stop(true);
	for (const dir of bases) rmSync(dir, { recursive: true, force: true });
});

async function until<T>(probe: () => T | undefined | false | null, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value as T;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(25);
	}
}

/** What a daemon is given: a home and an agent directory inside the test's own base, and nothing else. */
function isolatedEnv(dir: string): Record<string, string> {
	const home = join(dir, "home");
	const agent = join(dir, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agent, { recursive: true });
	return { HOME: home, TMPDIR: home, DRAHT_CODING_AGENT_DIR: agent };
}

async function started(options: Parameters<typeof startEmittedDaemon>[0]): Promise<EmittedDaemon> {
	const daemon = await startEmittedDaemon(options);
	daemons.push(daemon);
	return daemon;
}

const MINIMAL_CONFIG: GeistConfig = {
	harness: { default: "draht", agents: { draht: { cmd: "/bin/sh" } } },
	projects: { p: { root: "/tmp" } },
	approvedRoots: ["/tmp"],
};

describe("shortBase", () => {
	test("is a canonical private directory under /tmp, short enough for a session socket", () => {
		const dir = base("w5s-");

		expect(realpathSync(dir)).toBe(dir);
		expect(dir.startsWith(`${realpathSync("/tmp")}/w5s-`)).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(`${dir}/agent/sockets/00000000-0000-4000-8000-000000000000.sock`.length).toBeLessThan(104);
	});

	test("refuses a prefix that would leave no room, and leaves no directory behind", () => {
		const prefix = `w5-${randomBytes(4).toString("hex")}-${"x".repeat(60)}-`;

		try {
			expect(() => shortBase(prefix)).toThrow(/a session socket under it cannot bind/);
			expect(readdirSync("/tmp").filter((name) => name.startsWith(prefix))).toEqual([]);
		} finally {
			for (const name of readdirSync("/tmp").filter((entry) => entry.startsWith(prefix))) {
				rmSync(join("/tmp", name), { recursive: true, force: true });
			}
		}
	});
});

describe("writeRegistry", () => {
	test("writes a file the daemon's own loader accepts, 0600 in a 0700 directory it created", () => {
		const dir = base();
		const path = join(dir, "reg", "config.yaml");

		writeRegistry(path, MINIMAL_CONFIG);

		expect(loadGeistConfigFile(path)).toEqual(MINIMAL_CONFIG);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	});

	test("a wider mode is the loader's mode refusal, so the positive control above can fail", () => {
		const dir = base();
		const path = join(dir, "reg", "config.yaml");

		writeRegistry(path, MINIMAL_CONFIG, 0o644);

		expect(() => loadGeistConfigFile(path)).toThrow(RegistryFileRefusedError);
		expect(() => loadGeistConfigFile(path)).toThrow(/\(mode on file /);
	});

	test("never changes a directory that already exists", () => {
		const dir = base();
		const shared = join(dir, "shared");
		mkdirSync(shared);
		chmodSync(shared, 0o755);

		writeRegistry(join(shared, "config.yaml"), MINIMAL_CONFIG);

		expect(statSync(shared).mode & 0o777).toBe(0o755);
	});

	test("replaces the path by rename: a reader holding the old file never sees it truncated", () => {
		const dir = base();
		const path = join(dir, "reg", "config.yaml");
		writeRegistry(path, MINIMAL_CONFIG);
		const old = openSync(path, "r");

		const next: GeistConfig = { ...MINIMAL_CONFIG, approvedRoots: ["/tmp", "/var"] };
		writeRegistry(path, next);

		const buffer = Buffer.alloc(4096);
		const length = readSync(old, buffer, 0, buffer.length, 0);
		expect(JSON.parse(buffer.subarray(0, length).toString())).toEqual(MINIMAL_CONFIG);
		expect(loadGeistConfigFile(path)).toEqual(next);
	});

	test("replaces a symlink at the path with a regular file instead of writing through it", () => {
		const dir = base();
		const real = join(dir, "reg", "real.yaml");
		const path = join(dir, "reg", "config.yaml");
		writeRegistry(real, MINIMAL_CONFIG);
		symlinkSync(real, path);

		writeRegistry(path, { ...MINIMAL_CONFIG, approvedRoots: ["/var"] });

		expect(lstatSync(path).isFile()).toBe(true);
		expect(loadGeistConfigFile(real)).toEqual(MINIMAL_CONFIG);
	});
});

describe("shTripwire and jsFixture", () => {
	test("the tripwire writes its marker under the PATH a spawned child gets, and under no PATH at all", () => {
		const dir = base();
		const marker = join(dir, "marker");
		const tripwire = shTripwire(join(dir, "trip"), marker);

		expect(() => lstatSync(marker)).toThrow();
		for (const path of ["/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "/nonexistent"]) {
			const run = Bun.spawnSync(["/usr/bin/env", "-i", `PATH=${path}`, tripwire, "a", "b c"]);
			expect(run.exitCode).toBe(0);
		}

		const lines = readFileSync(marker, "utf8").trimEnd().split("\n");
		expect(lines).toEqual([`${tripwire} a b c`, `${tripwire} a b c`]);
		expect(statSync(tripwire).mode & 0o777).toBe(0o755);
	});

	test("a marker path holding a quote and a space is written to verbatim", () => {
		const dir = base();
		const marker = join(dir, "it's a marker");
		const tripwire = shTripwire(join(dir, "trip"), marker);

		expect(Bun.spawnSync(["/usr/bin/env", "-i", tripwire]).exitCode).toBe(0);

		expect(readFileSync(marker, "utf8")).toBe(`${tripwire} \n`);
	});

	test("jsFixture writes the source verbatim and the daemon's own bun runs it", () => {
		const dir = base();
		const fixture = jsFixture(join(dir, "fx.js"), 'process.stdout.write("ran " + process.argv[2]);');

		const run = Bun.spawnSync([BUN, fixture, "ok"]);

		expect(run.stdout.toString()).toBe("ran ok");
		expect(statSync(fixture).mode & 0o777).toBe(0o755);
	});
});

describe("descendantPids", () => {
	test("lists this process's children in ascending order, zombies included", async () => {
		const first = Bun.spawn([BUN, "-e", "setTimeout(() => {}, 600000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const second = Bun.spawn([BUN, "-e", "setTimeout(() => {}, 600000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		children.push(first, second);
		await until(() => isProcessAlive(first.pid) && isProcessAlive(second.pid), "both children to run");

		const pids = descendantPids(process.pid);

		expect(pids).toContain(first.pid);
		expect(pids).toContain(second.pid);
		expect(pids).toEqual([...pids].sort((a, b) => a - b));

		first.kill("SIGKILL");
		second.kill("SIGKILL");
	}, 60_000);
});

describe("startEmittedDaemon", () => {
	test("runs the emitted CLI with the flags it was given and answers /health", async () => {
		const dir = base();
		const work = join(dir, "work");
		mkdirSync(work);
		const registry = join(dir, "reg", "config.yaml");

		const daemon = await started({ registry, env: isolatedEnv(dir), cwd: work });

		expect((await fetch(`${daemon.httpBase}/health`)).status).toBe(200);
		expect(argvOf(daemon.pid)).toEqual([
			BUN,
			GATEWAY_CLI,
			"--host",
			"127.0.0.1",
			"--port",
			String(daemon.port),
			"--auth",
			daemon.token,
			"--registry",
			registry,
		]);
		expect(cwdOf(daemon.pid)).toBe(work);
		expect(daemon.stderr.text).toContain('"message":"draht-gateway listening"');
		expect(daemon.httpBase).toBe(`http://127.0.0.1:${daemon.port}`);
		expect(daemon.wsBase).toBe(`ws://127.0.0.1:${daemon.port}`);
	}, 60_000);

	test("builds the environment from scratch: what was given is there, and nothing of this process's is", async () => {
		const dir = base();
		const env = { ...isolatedEnv(dir), W5_GIVEN: uniqueMarker("given") };
		const canary = `W5_INHERITED_${randomBytes(6).toString("hex")}`;
		process.env[canary] = uniqueMarker("inherited");
		const inherited = Object.keys(process.env);
		let daemon: EmittedDaemon;
		try {
			daemon = await started({ registry: join(dir, "reg", "config.yaml"), env });
		} finally {
			delete process.env[canary];
		}

		const seen = envOf(daemon.pid);
		if (!seen.visible) throw new Error(`the daemon's environment is not visible: ${seen.reason}`);
		for (const [name, value] of Object.entries(env)) expect(seen.env.get(name)).toBe(value);
		expect(inherited).toContain("PATH");
		for (const name of inherited) {
			if (name in env) continue;
			expect(seen.env.has(name), `${name} reached the daemon`).toBe(false);
		}
		expect(seen.env.has(canary)).toBe(false);
	}, 60_000);

	test("refuses to start without a home and an agent directory, and starts nothing", async () => {
		const token = uniqueMarker("never-started");

		await expect(startEmittedDaemon({ token, env: { HOME: "/tmp" } })).rejects.toThrow(
			/env\.DRAHT_CODING_AGENT_DIR is required/,
		);

		expect(psRows().some((row) => row.command.includes(token))).toBe(false);
	});

	test("with no registry the flag is omitted and the default is read under the given HOME", async () => {
		const dir = base();
		const env = isolatedEnv(dir);

		const daemon = await started({ env });

		expect(argvOf(daemon.pid)).not.toContain("--registry");
		const before = await AttachClient.open(daemon.wsBase, daemon.token);
		expect((await before.hello()).capabilities).not.toContain("session-spawn");
		before.close();

		writeRegistry(join(env.HOME as string, ".geist", "config.yaml"), MINIMAL_CONFIG);
		const after = await AttachClient.open(daemon.wsBase, daemon.token);
		expect((await after.hello()).capabilities).toContain("session-spawn");
		after.close();
	}, 60_000);

	test("a daemon that exits before it listens is a DaemonStartError carrying its exit code and stderr", async () => {
		const dir = base();

		const failure = await startEmittedDaemon({ registry: "rel/x.yaml", env: isolatedEnv(dir) }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(DaemonStartError);
		const error = failure as DaemonStartError;
		expect(error.exitCode).toBe(1);
		expect(error.stderr).toContain("--registry must be an absolute path, got: rel/x.yaml");
		expect(error.message).toContain('before logging "draht-gateway listening"');
		expect(isProcessAlive(error.pid)).toBe(false);
	}, 60_000);

	test("a daemon still starting at the deadline is killed, and the error names what was awaited", async () => {
		const dir = base();

		const failure = await startEmittedDaemon({ env: isolatedEnv(dir), startupTimeoutMs: 1 }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(DaemonStartError);
		const error = failure as DaemonStartError;
		expect(error.message).toMatch(
			/^timed out after 1 ms waiting for the daemon \(pid \d+\) to log "draht-gateway listening"/,
		);
		expect(error.exitCode).toBeNull();
		expect(isProcessAlive(error.pid)).toBe(false);
		expect(psRows().some((row) => row.command.includes(GATEWAY_CLI) && row.pid === error.pid)).toBe(false);
	}, 60_000);
});

describe("dispose leaves no daemon process behind, shown with ps", () => {
	test("after dispose the daemon is not in the process table and stops answering", async () => {
		const dir = base();
		const daemon = await started({ env: isolatedEnv(dir) });
		expect(psRows().some((row) => row.pid === daemon.pid && row.command.includes(daemon.token))).toBe(true);

		const first = daemon.dispose();
		expect(daemon.dispose()).toBe(first);
		await first;

		expect(psRows().some((row) => row.command.includes(daemon.token))).toBe(false);
		expect(rowFor(daemon.pid)).toBeUndefined();
		await expect(fetch(`${daemon.httpBase}/health`)).rejects.toThrow();
	}, 60_000);

	test("a daemon that cannot act on SIGTERM is killed after the grace period", async () => {
		const dir = base();
		const daemon = await started({ env: isolatedEnv(dir), terminateGraceMs: 300 });
		// A stopped process holds SIGTERM pending: only SIGKILL can end it.
		process.kill(daemon.pid, "SIGSTOP");
		await until(() => rowFor(daemon.pid)?.stat.includes("T"), `${daemon.pid} to be stopped`);

		const startedAt = Date.now();
		await daemon.dispose();

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
		expect(psRows().some((row) => row.command.includes(daemon.token))).toBe(false);
	}, 60_000);

	test("a daemon that is already dead disposes cleanly", async () => {
		const dir = base();
		const daemon = await started({ env: isolatedEnv(dir) });
		process.kill(daemon.pid, "SIGKILL");
		await until(() => !isProcessAlive(daemon.pid), `${daemon.pid} to die`);

		await daemon.dispose();

		expect(psRows().some((row) => row.command.includes(daemon.token))).toBe(false);
	}, 60_000);
});

describe("AttachClient against the daemon", () => {
	test("a tripwire harness is listed without its path, and a spawn of it fires the tripwire", async () => {
		const dir = base();
		const bin = join(dir, "bin");
		const project = join(dir, "work", "p");
		mkdirSync(bin);
		mkdirSync(project, { recursive: true });
		const marker = join(dir, "marker");
		const tripwire = shTripwire(join(bin, "draht-trip"), marker);
		const registry = join(dir, "reg", "config.yaml");
		const config: GeistConfig = {
			harness: { default: "draht", agents: { draht: { cmd: tripwire } } },
			projects: { p: { root: project, name: "P" } },
			approvedRoots: [dir],
		};
		writeRegistry(registry, config);
		const daemon = await started({ registry, env: isolatedEnv(dir) });
		const client = await AttachClient.open(daemon.wsBase, daemon.token);

		const hello = await client.hello();
		expect(hello.capabilities).toContain("session-spawn");
		expect(hello.capabilities).toContain("registry");
		const listed = await client.ask({ type: "registry_resync" }, "registry");
		expect(listed.harnesses).toEqual([{ id: "draht", isDefault: true }]);
		expect(client.rawOf("registry")).not.toContain(tripwire);
		expect(() => lstatSync(marker)).toThrow();

		// The second answer is the one to this frame, not the first one still sitting in the list.
		writeRegistry(registry, { ...config, projects: { ...config.projects, q: { root: project, name: "Q" } } });
		const relisted = await client.ask({ type: "registry_resync" }, "registry");
		expect(relisted.projects.map((entry) => entry.id)).toEqual(["p", "q"]);

		const answer = await client.ask(
			{ type: "session_spawn", harnessId: "draht", projectId: "p" },
			"session_spawned",
			45_000,
		);

		expect(answer).toMatchObject({ ok: false, code: "spawn_failed" });
		expect(readFileSync(marker, "utf8").trimEnd().split("\n")).toHaveLength(1);
		client.close();
	}, 90_000);

	test("an unreachable port is a refusal naming the socket, not a hang", async () => {
		const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
		const port = probe.port;
		probe.stop(true);

		await expect(AttachClient.open(`ws://127.0.0.1:${port}`, "t", 5_000)).rejects.toThrow(
			`the daemon refused a socket at ws://127.0.0.1:${port}/attach`,
		);
	});
});

/**
 * The error a promise rejects with. Not `expect(promise).rejects`: under bun test that stops a socket from delivering
 * messages that are already pending while it waits, so a wait on one times out although the frame is there.
 */
async function failure(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("expected a rejection, but the promise resolved");
		},
		(error: unknown) => error as Error,
	);
}

describe("AttachClient fails closed", () => {
	function fakeDaemon(onOpen: (ws: Bun.ServerWebSocket<undefined>) => void): string {
		const server = Bun.serve<undefined>({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request, upgrader) {
				if (upgrader.upgrade(request)) return undefined;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					onOpen(ws);
				},
				message() {},
			},
		});
		servers.push(server);
		return `ws://127.0.0.1:${server.port}`;
	}

	test("a frame the protocol schema rejects fails the wait, naming the frame", async () => {
		const client = await AttachClient.open(
			fakeDaemon((ws) => ws.send(JSON.stringify({ type: "nonsense", payload: 1 }))),
			"t",
		);

		const error = await failure(client.waitFor(() => false, "anything", 2_000));

		expect(error.message).toContain(
			"the daemon sent a frame ServerFrameSchema rejects, while waiting for anything: ",
		);
		expect(error.message).toContain('in {"type":"nonsense","payload":1}');
	});

	test("a socket that closes fails the wait with the close code instead of running to the deadline", async () => {
		const client = await AttachClient.open(
			fakeDaemon((ws) => ws.close(4001, "bye")),
			"t",
		);

		const error = await failure(client.waitFor(() => false, "a frame", 10_000));

		expect(error.message).toBe('the /attach socket closed (4001 "bye") while waiting for a frame (saw: nothing)');
		expect(client.closed).toEqual({ code: 4001, reason: "bye" });
	});

	test("a wait that expires says how long and what for", async () => {
		const client = await AttachClient.open(
			fakeDaemon(() => {}),
			"t",
		);

		const error = await failure(client.waitFor(() => false, "a frame that never comes", 150));

		expect(error.message).toBe("timed out after 150 ms waiting for a frame that never comes (saw: nothing)");
		client.close();
	});

	test("rawOf keeps the key the parse strips, and throws rather than answer an empty string", async () => {
		const client = await AttachClient.open(
			fakeDaemon((ws) => ws.send(JSON.stringify({ type: "fleet", sessions: [], epoch: "e", seq: 0, extra: 1 }))),
			"t",
		);

		expect(() => client.rawOf("fleet")).toThrow("no fleet frame has arrived (saw: nothing)");
		await client.waitFor((frame) => frame.type === "fleet", "the fleet frame");

		expect(client.frames[0]).not.toHaveProperty("extra");
		expect(client.rawOf("fleet")).toContain('"extra":1');
		expect(client.raw).toHaveLength(client.frames.length);
		client.close();
	});
});
