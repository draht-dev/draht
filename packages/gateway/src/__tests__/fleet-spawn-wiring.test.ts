/**
 * R36-SPAWN.1 — the daemon's `/attach` route answers `session_spawn` and `registry`
 * from the user's registry, through one spawner and one launcher.
 *
 * A real `createServer` over a real `Bun.serve`, driven by real frames on a real
 * WebSocket, with harnesses that are `.js` fixtures run by this process's own bun.
 * `spawn-fleet-join.e2e.test.ts` drives the same verb against the emitted daemon.
 *
 * Every fixture is a tripwire: its first act is to append a line to a file, so
 * "no process was started" means that file does not exist, and "exactly one" means
 * it has exactly one line. Fixtures are `.js` because the child a daemon spawns has
 * a PATH that may hold no coreutils.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import { websocket } from "hono/bun";
import { createFleetRoutes } from "../gateway/routes/fleet";
import { createServer } from "../gateway/server";
import { type UserRegistry, userRegistry } from "../session/harness-resolver";

const TOKEN = "fleet-spawn-wiring-operator-token";
const PROJECT = "fixture";

/** The Wire waits up to 5 s for the socket and 10 s for a reply; bun's 5 s default would cut a slow test off first. */
const WIRE_TIMEOUT_MS = 20_000;

const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const undo of cleanup.splice(0).reverse()) undo();
});

/** A throwaway directory that is gone when the test is. Under /tmp so a socket path stays short. */
function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function directory(path: string, mode = 0o755): string {
	mkdirSync(path, { recursive: true, mode });
	chmodSync(path, mode);
	return path;
}

/** The harness a daemon would run: record that it ran, then stay alive `lingerMs` before exiting. */
function tripwireFixture(path: string, tripwire: string, lingerMs: number): string {
	writeFileSync(
		path,
		[
			`import { appendFileSync } from "node:fs";`,
			`appendFileSync(${JSON.stringify(tripwire)}, "ran\\n");`,
			`setTimeout(() => process.exit(0), ${lingerMs});`,
			"",
		].join("\n"),
	);
	return path;
}

function lines(path: string): number {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

interface World {
	base: string;
	registry: UserRegistry;
	registryPath: string;
	socketDir: string;
	sessionsDir: string;
	drahtScript: string;
	drahtTripwire: string;
	codexScript: string;
	codexTripwire: string;
	/** Write the registry declaring draht and codex over one project, at `mode`. */
	writeRegistry(mode?: number): void;
}

/** Nothing is written to the registry path yet: a daemon that has never been given one. */
function world(options: { drahtLingerMs?: number } = {}): World {
	const base = tempDir("fsw-");
	const bin = directory(join(base, "bin"));
	const projectRoot = directory(join(base, "work", PROJECT));
	const drahtTripwire = join(base, "draht.tripwire");
	const codexTripwire = join(base, "codex.tripwire");
	const drahtScript = tripwireFixture(join(bin, "draht.js"), drahtTripwire, options.drahtLingerMs ?? 0);
	const codexScript = tripwireFixture(join(bin, "codex.js"), codexTripwire, 0);
	const registryDir = directory(join(base, "reg"), 0o700);
	const registryPath = join(registryDir, "config.yaml");
	const agentDir = directory(join(base, "agent"));

	return {
		base,
		registry: userRegistry({ explicit: registryPath }),
		registryPath,
		socketDir: directory(join(agentDir, "sockets")),
		sessionsDir: directory(join(agentDir, "sessions")),
		drahtScript,
		drahtTripwire,
		codexScript,
		codexTripwire,
		writeRegistry(mode = 0o600) {
			// JSON is valid YAML.
			writeFileSync(
				registryPath,
				JSON.stringify({
					harness: { default: "draht", agents: { draht: { cmd: drahtScript }, codex: { cmd: codexScript } } },
					projects: { [PROJECT]: { root: projectRoot, name: "Fixture" } },
					approvedRoots: [base],
				}),
			);
			chmodSync(registryPath, mode);
		},
	};
}

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch, websocket });
	cleanup.push(() => server.stop(true));
	return `ws://127.0.0.1:${server.port}/attach`;
}

function daemon(w: World): string {
	const { app } = createServer({
		port: 0,
		authToken: TOKEN,
		socketDir: w.socketDir,
		sessionsDir: w.sessionsDir,
		userRegistry: w.registry,
	});
	return serve(app.fetch);
}

type FrameOf<T extends GeistServerFrame["type"]> = Extract<GeistServerFrame, { type: T }>;

/** One authenticated renderer connection that keeps both the parsed frames and the exact text they arrived as. */
class Wire {
	readonly frames: GeistServerFrame[] = [];
	readonly raw: string[] = [];
	readonly #ws: WebSocket;

	constructor(url: string) {
		this.#ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
		this.#ws.addEventListener("message", (event: MessageEvent) => {
			this.raw.push(String(event.data));
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		cleanup.push(() => this.#ws.close());
	}

	get open(): boolean {
		return this.#ws.readyState === WebSocket.OPEN;
	}

	/** Send one frame and return the first `reply` frame that arrives after it. */
	async ask<T extends GeistServerFrame["type"]>(frame: Record<string, unknown>, reply: T): Promise<FrameOf<T>> {
		const from = this.frames.length;
		await this.#opened();
		this.#ws.send(JSON.stringify(frame));
		return this.#waitFor(from, reply);
	}

	async hello(): Promise<FrameOf<"server_hello">> {
		return this.ask(
			{
				type: "hello",
				protocol: GEIST_PROTOCOL_FAMILY,
				version: GEIST_PROTOCOL_VERSION,
				client: { name: "fleet-spawn-wiring", version: "0.0.0" },
			},
			"server_hello",
		);
	}

	spawn(harnessId: string, projectId = PROJECT): Promise<FrameOf<"session_spawned">> {
		return this.ask({ type: "session_spawn", harnessId, projectId }, "session_spawned");
	}

	registry(): Promise<FrameOf<"registry">> {
		return this.ask({ type: "registry_resync" }, "registry");
	}

	/** The exact text of the last frame of `type`, for assertions about what never crossed the wire. */
	rawOf(type: GeistServerFrame["type"]): string {
		const index = this.frames.findLastIndex((frame) => frame.type === type);
		return this.raw[index] ?? "";
	}

	async #opened(): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (this.#ws.readyState === WebSocket.CONNECTING && Date.now() < deadline) await Bun.sleep(5);
		if (this.#ws.readyState !== WebSocket.OPEN) throw new Error("the /attach socket did not open");
	}

	async #waitFor<T extends GeistServerFrame["type"]>(from: number, type: T): Promise<FrameOf<T>> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const found = this.frames.slice(from).find((frame): frame is FrameOf<T> => frame.type === type);
			if (found) return found;
			await Bun.sleep(5);
		}
		throw new Error(`timed out waiting for ${type} (saw: ${this.frames.map((frame) => frame.type).join(", ")})`);
	}
}

/** A connection that has completed `hello`, and what the daemon said back. */
async function connected(url: string): Promise<{ wire: Wire; capabilities: readonly string[] }> {
	const wire = new Wire(url);
	return { wire, capabilities: (await wire.hello()).capabilities };
}

describe("with no registry file, spawning is not offered", () => {
	test(
		"neither capability is advertised, session_spawn is refused, and registry answers empty",
		async () => {
			const w = world();
			const { wire, capabilities } = await connected(daemon(w));

			expect(capabilities).not.toContain("session-spawn");
			expect(capabilities).not.toContain("registry");

			const refused = await wire.spawn("draht");
			expect(refused).toMatchObject({ ok: false, code: "refused" });
			expect(refused.message).toBe("this daemon cannot spawn sessions");
			expect(await wire.registry()).toMatchObject({ harnesses: [], projects: [] });
			expect(lines(w.drahtTripwire)).toBe(0);
		},
		WIRE_TIMEOUT_MS,
	);

	test(
		"a daemon built with no registry at all never offers it either",
		async () => {
			const w = world();
			w.writeRegistry();
			const { app } = createServer({
				port: 0,
				authToken: TOKEN,
				socketDir: w.socketDir,
				sessionsDir: w.sessionsDir,
			});

			const { capabilities } = await connected(serve(app.fetch));

			expect(capabilities).not.toContain("session-spawn");
			expect(capabilities).not.toContain("registry");
		},
		WIRE_TIMEOUT_MS,
	);
});

describe("a registry written after the routes were built is offered to the next connection", () => {
	test(
		"both capabilities appear, and only draht is listed although codex is declared",
		async () => {
			const w = world();
			const url = daemon(w);
			const before = await connected(url);
			expect(before.capabilities).not.toContain("session-spawn");

			w.writeRegistry();
			const { wire, capabilities } = await connected(url);

			expect(capabilities).toContain("session-spawn");
			expect(capabilities).toContain("registry");
			const listed = await wire.registry();
			expect(listed.harnesses).toEqual([{ id: "draht", isDefault: true }]);
			expect(listed.projects).toEqual([{ id: PROJECT, name: "Fixture", root: join(w.base, "work", PROJECT) }]);
			const text = wire.rawOf("registry");
			expect(text).not.toContain(w.drahtScript);
			expect(text).not.toContain(w.codexScript);
			expect(text).not.toContain("codex");

			// The first connection was told what it was told: its hello and its answers agree for its whole life.
			expect(await before.wire.spawn("draht")).toMatchObject({ ok: false, code: "refused" });
			expect(lines(w.drahtTripwire)).toBe(0);
		},
		WIRE_TIMEOUT_MS,
	);

	test(
		"a registry the loader will refuse is still offered, and the refusal arrives on the wire",
		async () => {
			const w = world();
			w.writeRegistry(0o644);

			const { wire, capabilities } = await connected(daemon(w));

			expect(capabilities).toContain("session-spawn");
			expect(capabilities).toContain("registry");
			const refused = await wire.spawn("draht");
			expect(refused).toMatchObject({ ok: false, code: "refused" });
			expect(refused.message).toContain("(mode on file");
		},
		WIRE_TIMEOUT_MS,
	);
});

describe("only the v1 spawnable harnesses can be asked for", () => {
	test(
		"codex is declared, and a spawn of it is answered unknown_harness at once with nothing started",
		async () => {
			const w = world();
			w.writeRegistry();
			// The tripwire can fire: the same fixture, run by hand, records itself.
			expect(Bun.spawnSync([process.execPath, w.codexScript]).exitCode).toBe(0);
			expect(lines(w.codexTripwire)).toBe(1);
			rmSync(w.codexTripwire);
			const { wire } = await connected(daemon(w));

			const startedAt = Date.now();
			const answer = await wire.spawn("codex");
			const elapsed = Date.now() - startedAt;

			expect(answer).toMatchObject({ ok: false, code: "unknown_harness" });
			expect(answer.message).toContain("declared but not spawnable");
			expect(elapsed).toBeLessThan(2_000);
			await Bun.sleep(300);
			expect(existsSync(w.codexTripwire)).toBe(false);
		},
		WIRE_TIMEOUT_MS,
	);
});

describe("the registry file is re-checked on every frame", () => {
	test(
		"a file made group-readable under a live connection is refused with the rule, and the connection survives",
		async () => {
			const w = world();
			w.writeRegistry();
			const { wire } = await connected(daemon(w));
			expect((await wire.registry()).harnesses).toHaveLength(1);

			chmodSync(w.registryPath, 0o644);
			const refused = await wire.spawn("draht");

			expect(refused).toMatchObject({ ok: false, code: "refused" });
			expect(refused.message).toContain("(mode on file");
			expect(refused.sessionId).toBeUndefined();
			await Bun.sleep(300);
			expect(existsSync(w.drahtTripwire)).toBe(false);
			expect(wire.open).toBe(true);
			expect(await wire.registry()).toMatchObject({ harnesses: [], projects: [] });

			// The pair is the test: the same connection, the same frame, the file mended.
			chmodSync(w.registryPath, 0o600);
			const mended = await wire.spawn("draht");
			expect(mended.code).toBe("spawn_failed");
			expect(lines(w.drahtTripwire)).toBe(1);
		},
		WIRE_TIMEOUT_MS,
	);
});

describe("one launcher serves the whole daemon", () => {
	test(
		"two connections asking for one pair at once start exactly one process",
		async () => {
			// Lingers past both asks, so the second arrives while the first is still in flight.
			const w = world({ drahtLingerMs: 1_500 });
			w.writeRegistry();
			const url = daemon(w);
			const [first, second] = await Promise.all([connected(url), connected(url)]);

			const answers = await Promise.all([first.wire.spawn("draht"), second.wire.spawn("draht")]);

			expect(lines(w.drahtTripwire)).toBe(1);
			// The fixture publishes no socket and exits, so the connection that won the claim is told spawn_failed.
			expect(answers.map((answer) => answer.code).sort()).toEqual(["refused", "spawn_failed"]);
			// The launcher's message, not the bridge's per-connection one: each connection here asked only once.
			const refused = answers.find((answer) => answer.code === "refused");
			expect(refused?.message).toContain("a spawn for this project and harness is already in flight");
		},
		WIRE_TIMEOUT_MS,
	);
});

describe("an injected spawnSession port", () => {
	test(
		"is advertised with no registry file and is what answers",
		async () => {
			const w = world();
			const asked: { harnessId: string; projectId: string }[] = [];
			const app = createFleetRoutes({
				socketDir: w.socketDir,
				sessionsDir: w.sessionsDir,
				authToken: TOKEN,
				spawnSession: async (request) => {
					asked.push(request);
					return { code: "spawned", sessionId: "11111111-1111-4111-8111-111111111111" };
				},
			});
			const { wire, capabilities } = await connected(serve(app.fetch));

			expect(capabilities).toContain("session-spawn");
			expect(capabilities).not.toContain("registry");
			expect(await wire.spawn("draht")).toMatchObject({
				ok: true,
				code: "spawned",
				sessionId: "11111111-1111-4111-8111-111111111111",
			});
			expect(asked).toEqual([{ harnessId: "draht", projectId: PROJECT }]);
			expect(lines(w.drahtTripwire)).toBe(0);
		},
		WIRE_TIMEOUT_MS,
	);
});
