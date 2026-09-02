/**
 * R36-SPAWN.1, R36-SPAWN.3 — the bridge's half of `session_spawn` and
 * `registry_resync`.
 *
 * The session below is a REAL Unix socket with a real `<id>.lock` beside it, so
 * "no socket was dialled" is an assertion about a session that could have been
 * dialled. The two ports are stand-ins because what they stand for — a process
 * being started — is the shipped daemon's, wired in a later wave.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	DEFAULT_TRANSPORT_LIMITS,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
	SessionSpawnCodeSchema,
} from "@draht/geist-protocol";
import {
	AttachBridge,
	type AttachBridgeOptions,
	type DeviceAuthenticator,
	type RendererConnection,
} from "../../src/attach/attach-bridge.js";

const SESSION_ID = "session-under-test";
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

let socketDir: string;
let session: Server;
let sessionSockets: Socket[] = [];
const bridges: AttachBridge[] = [];

class FakeRenderer implements RendererConnection {
	readonly sent: string[] = [];
	readonly closes: { code: number; reason: string }[] = [];

	bufferedBytes(): number {
		return 0;
	}

	send(text: string): void {
		this.sent.push(text);
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
	}

	frames(): GeistServerFrame[] {
		return this.sent.map((text) => ServerFrameSchema.parse(JSON.parse(text)));
	}

	types(): string[] {
		return this.frames().map((frame) => frame.type);
	}

	last(): GeistServerFrame {
		const frames = this.frames();
		const frame = frames[frames.length - 1];
		if (!frame) throw new Error("renderer received no frames");
		return frame;
	}
}

beforeEach(async () => {
	socketDir = mkdtempSync("/tmp/geist-spawn-");
	sessionSockets = [];

	session = createServer((socket) => {
		sessionSockets.push(socket);
		socket.on("data", () => {});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve, reject) => {
		session.once("error", reject);
		session.listen(join(socketDir, `${SESSION_ID}.sock`), resolve);
	});
	writeFileSync(
		join(socketDir, `${SESSION_ID}.lock`),
		`${process.pid}\n/work/session\n2026-08-22T09:00:00.000Z\n${PROCESS_STARTED_AT_MS}`,
		{ mode: 0o600 },
	);
});

afterEach(() => {
	for (const bridge of bridges) bridge.close();
	bridges.length = 0;
	for (const socket of sessionSockets) socket.destroy();
	session.close();
	rmSync(socketDir, { recursive: true, force: true });
});

function makeBridge(renderer: FakeRenderer, overrides: Partial<AttachBridgeOptions> = {}): AttachBridge {
	const bridge = new AttachBridge({
		socketDir,
		connection: renderer,
		limits: DEFAULT_TRANSPORT_LIMITS,
		drainCheckMs: 5,
		...overrides,
	});
	bridges.push(bridge);
	return bridge;
}

function hello(): string {
	return JSON.stringify({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "test-renderer", version: "0.0.0" },
	});
}

function spawnFrame(harnessId = "draht", projectId = "fr3n"): string {
	return JSON.stringify({ type: "session_spawn", harnessId, projectId });
}

/** Wait until `predicate` holds, or fail with what was actually seen. */
async function until(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function capabilitiesOf(renderer: FakeRenderer): string[] {
	const greeting = renderer.frames().find((frame) => frame.type === "server_hello");
	if (greeting?.type !== "server_hello") throw new Error("no server_hello was sent");
	return greeting.capabilities;
}

describe("what the daemon advertises is what it will answer", () => {
	test("neither capability is declared by a bridge given neither port", () => {
		const renderer = new FakeRenderer();
		makeBridge(renderer).receive(hello());

		expect(capabilitiesOf(renderer)).not.toContain("session-spawn");
		expect(capabilitiesOf(renderer)).not.toContain("registry");
	});

	test("each capability is declared exactly when its own port is present", () => {
		const spawnOnly = new FakeRenderer();
		makeBridge(spawnOnly, { spawnSession: async () => ({ code: "spawned", sessionId: "s1" }) }).receive(hello());
		expect(capabilitiesOf(spawnOnly)).toContain("session-spawn");
		expect(capabilitiesOf(spawnOnly)).not.toContain("registry");

		const registryOnly = new FakeRenderer();
		makeBridge(registryOnly, { registry: () => ({ harnesses: [], projects: [] }) }).receive(hello());
		expect(capabilitiesOf(registryOnly)).toContain("registry");
		expect(capabilitiesOf(registryOnly)).not.toContain("session-spawn");
	});
});

describe("both geist/0.5 verbs are post-authentication", () => {
	const devices: DeviceAuthenticator = {
		pair: () => ({ ok: false, reason: "unknown_token" }),
		authenticate: () => ({ ok: false, reason: "unknown_device" }),
	};

	test("a spawn before any credential is refused not_authenticated and no port is called", () => {
		const renderer = new FakeRenderer();
		let called = 0;
		const bridge = makeBridge(renderer, {
			devices,
			spawnSession: async () => {
				called += 1;
				return { code: "spawned", sessionId: "s1" };
			},
		});

		bridge.receive(hello());
		bridge.receive(spawnFrame());

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
		expect(called).toBe(0);
	});

	test("a registry_resync before any credential is refused and the registry is never read", () => {
		const renderer = new FakeRenderer();
		let read = 0;
		const bridge = makeBridge(renderer, {
			devices,
			registry: () => {
				read += 1;
				return { harnesses: [], projects: [{ id: "secret", name: "secret", root: "/private/secret" }] };
			},
		});

		bridge.receive(hello());
		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.types()).not.toContain("registry");
		expect(renderer.sent.join("")).not.toContain("/private/secret");
		expect(read).toBe(0);
	});
});

describe("session_spawn is answered, never dropped and never closed", () => {
	test("a bridge with no port answers refused and keeps the connection", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(spawnFrame());

		expect(renderer.last()).toMatchObject({ type: "session_spawned", ok: false, code: "refused" });
		expect(renderer.closes).toHaveLength(0);
	});

	test("a refusal drops the session id even when the port hands one over", async () => {
		for (const code of SessionSpawnCodeSchema.options.filter((option) => option !== "spawned")) {
			const renderer = new FakeRenderer();
			const bridge = makeBridge(renderer, { spawnSession: async () => ({ code, sessionId: "leaked" }) });
			bridge.receive(hello());
			bridge.receive(spawnFrame());
			await until(() => renderer.types().includes("session_spawned"), `the ${code} answer`);
			expect(renderer.last()).toMatchObject({ type: "session_spawned", ok: false, code });
			expect("sessionId" in renderer.last()).toBe(false);
			expect(renderer.sent[renderer.sent.length - 1]).not.toContain("leaked");
		}
	});

	test("exactly one code carries ok true", async () => {
		for (const code of SessionSpawnCodeSchema.options) {
			const renderer = new FakeRenderer();
			const bridge = makeBridge(renderer, { spawnSession: async () => ({ code, sessionId: "minted-1" }) });
			bridge.receive(hello());
			bridge.receive(spawnFrame());
			await until(() => renderer.types().includes("session_spawned"), `the ${code} answer`);
			expect(renderer.last()).toMatchObject({ code, ok: code === "spawned" });
		}
	});

	test("a minted id the wire cannot carry is dropped, and the spawn is still reported as one", async () => {
		for (const sessionId of ["s".repeat(129), ""]) {
			const renderer = new FakeRenderer();
			const bridge = makeBridge(renderer, { spawnSession: async () => ({ code: "spawned", sessionId }) });
			bridge.receive(hello());

			bridge.receive(spawnFrame());

			await until(() => renderer.types().includes("session_spawned"), "the answer");
			expect(renderer.last()).toMatchObject({ type: "session_spawned", ok: true, code: "spawned" });
			expect("sessionId" in renderer.last()).toBe(false);
			expect(renderer.closes).toHaveLength(0);
		}
		const carried = new FakeRenderer();
		const bridge = makeBridge(carried, {
			spawnSession: async () => ({ code: "spawned", sessionId: "s".repeat(128) }),
		});
		bridge.receive(hello());
		bridge.receive(spawnFrame());
		await until(() => carried.types().includes("session_spawned"), "the answer");
		expect(carried.last()).toMatchObject({ sessionId: "s".repeat(128) });
	});

	test("a success names the one the port minted", async () => {
		const spawning = new FakeRenderer();
		const spawner = makeBridge(spawning, { spawnSession: async () => ({ code: "spawned", sessionId: "minted-1" }) });
		spawner.receive(hello());
		spawner.receive(spawnFrame());
		await until(() => spawning.types().includes("session_spawned"), "the answer");
		expect(spawning.last()).toMatchObject({
			type: "session_spawned",
			ok: true,
			code: "spawned",
			sessionId: "minted-1",
		});
	});

	test("the port is given exactly the two ids that crossed the wire", async () => {
		const renderer = new FakeRenderer();
		const seen: unknown[] = [];
		const bridge = makeBridge(renderer, {
			spawnSession: async (request) => {
				seen.push(request);
				return { code: "spawned", sessionId: "s1" };
			},
		});
		bridge.receive(hello());

		bridge.receive(spawnFrame("codex", "draht-mono"));

		await until(() => seen.length === 1, "the port to be called");
		expect(seen[0]).toEqual({ harnessId: "codex", projectId: "draht-mono" });
	});

	test("a second spawn while one is in flight is refused, not disconnected", async () => {
		const renderer = new FakeRenderer();
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const bridge = makeBridge(renderer, {
			spawnSession: async () => {
				calls += 1;
				await pending;
				return { code: "spawned", sessionId: "s1" };
			},
		});
		bridge.receive(hello());

		bridge.receive(spawnFrame());
		bridge.receive(spawnFrame());

		expect(renderer.last()).toMatchObject({ type: "session_spawned", ok: false, code: "refused" });
		expect(renderer.closes).toHaveLength(0);
		expect(calls).toBe(1);
		release?.();
		await until(() => renderer.types().filter((type) => type === "session_spawned").length === 2, "the first answer");
		expect(renderer.last()).toMatchObject({ ok: true, code: "spawned" });

		// The flag is a rate bound, not a one-shot: a connection that spawned once
		// must be able to spawn again.
		bridge.receive(spawnFrame());
		await until(() => calls === 2, "the second spawn to reach the port");
	});

	test("a port that throws is reported spawn_failed and the connection can spawn again", async () => {
		const renderer = new FakeRenderer();
		let calls = 0;
		const bridge = makeBridge(renderer, {
			spawnSession: async () => {
				calls += 1;
				throw new Error("the resolver exploded");
			},
		});
		bridge.receive(hello());

		bridge.receive(spawnFrame());

		await until(() => renderer.types().includes("session_spawned"), "the answer");
		expect(renderer.last()).toMatchObject({ type: "session_spawned", ok: false, code: "spawn_failed" });
		expect(renderer.closes).toHaveLength(0);

		// Survival means the connection can still spawn: a flag released anywhere but
		// `finally` leaves it stuck true and every later spawn answered `refused`.
		bridge.receive(spawnFrame());
		await until(() => calls === 2, "the spawn after the throw to reach the port");
	});

	test("a message longer than the wire bound is truncated, not thrown on", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			spawnSession: async () => ({ code: "spawn_failed", message: "e".repeat(5000) }),
		});
		bridge.receive(hello());

		bridge.receive(spawnFrame());

		await until(() => renderer.types().includes("session_spawned"), "the answer");
		const frame = renderer.last();
		if (frame.type !== "session_spawned") throw new Error(`expected a session_spawned, got ${frame.type}`);
		// The payload itself, cut to fit — not a schema complaint about it. A bound
		// applied too late throws inside `#emit`, and the throw is caught and
		// reported as a `spawn_failed` whose message is the zod error.
		expect(frame.message).toMatch(/^e+$/);
		expect(frame.message.length).toBeLessThanOrEqual(512);
		expect(renderer.closes).toHaveLength(0);
	});

	test("a message carrying a control code point is neutralized rather than throwing on the way out", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			spawnSession: async () => ({ code: "spawn_failed", message: "ENOENT: /work/p‮roj" }),
		});
		bridge.receive(hello());

		bridge.receive(spawnFrame());

		await until(() => renderer.types().includes("session_spawned"), "the answer");
		expect(renderer.last()).toMatchObject({ code: "spawn_failed", message: "ENOENT: /work/ p roj" });
	});
});

describe("registry_resync answers a registry", () => {
	test("the port is asked per frame, so a registry that changes is seen without a reconnect", () => {
		const renderer = new FakeRenderer();
		let harnesses = [{ id: "draht", isDefault: true }];
		const bridge = makeBridge(renderer, { registry: () => ({ harnesses, projects: [] }) });
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));
		expect(renderer.last()).toMatchObject({ type: "registry", harnesses: [{ id: "draht", isDefault: true }] });

		harnesses = [
			{ id: "draht", isDefault: true },
			{ id: "codex", isDefault: false },
		];
		bridge.receive(JSON.stringify({ type: "registry_resync" }));
		expect(renderer.last()).toMatchObject({ harnesses: [{ id: "draht" }, { id: "codex" }] });
	});

	test("a harness cmd the port leaks does not reach the wire", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({
				harnesses: [{ id: "draht", isDefault: true, cmd: "/usr/local/bin/draht" } as never],
				projects: [],
			}),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.sent[renderer.sent.length - 1]).not.toContain("/usr/local/bin/draht");
	});

	test("a project name or root carrying a control code point is neutralized rather than throwing", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({ harnesses: [], projects: [{ id: "p", name: "frn", root: "/work/‮fr3n" }] }),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toMatchObject({ projects: [{ id: "p", name: "fr n", root: "/work/ fr3n" }] });
	});

	test("a name or root longer than the wire bound is truncated, not thrown on", () => {
		// `#emit` parses every frame against the schema and a violation THROWS,
		// which inside `receive` would take the connection down over a long path.
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({
				harnesses: [],
				projects: [{ id: "p", name: "n".repeat(5000), root: `/${"r".repeat(5000)}` }],
			}),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		const frame = renderer.last();
		if (frame.type !== "registry") throw new Error(`expected a registry, got ${frame.type}`);
		expect(frame.projects[0]?.name).toHaveLength(200);
		expect(frame.projects[0]?.root).toHaveLength(1024);
		expect(renderer.closes).toHaveLength(0);
	});

	test("a row whose id the wire would refuse is dropped, and the rest of the registry still crosses", () => {
		// `projects` and `agents` are `z.record(z.string(), …)` in geist.yaml, so the
		// KEY is unbounded and `#emit` throws on one the wire's id schema refuses.
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({
				harnesses: [
					{ id: "bin/draht", isDefault: true },
					{ id: "draht", isDefault: true },
				],
				projects: [
					{ id: "draht mono", name: "draht mono", root: "/work/a" },
					{ id: "..", name: "dotdot", root: "/work/b" },
					{ id: "-leading", name: "leading", root: "/work/c" },
					{ id: "x".repeat(65), name: "long", root: "/work/d" },
					{ id: "fr3n", name: "fr3n", root: "/work/fr3n" },
				],
			}),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toEqual({
			type: "registry",
			harnesses: [{ id: "draht", isDefault: true }],
			projects: [{ id: "fr3n", name: "fr3n", root: "/work/fr3n" }],
		});
		expect(renderer.closes).toHaveLength(0);
	});

	test("more rows than the wire carries are capped rather than thrown on", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({
				harnesses: Array.from({ length: 100 }, (_, index) => ({ id: `h${index}`, isDefault: index === 0 })),
				projects: Array.from({ length: 300 }, (_, index) => ({
					id: `p${index}`,
					name: `p${index}`,
					root: `/work/p${index}`,
				})),
			}),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		const frame = renderer.last();
		if (frame.type !== "registry") throw new Error(`expected a registry, got ${frame.type}`);
		expect(frame.harnesses).toHaveLength(64);
		expect(frame.projects).toHaveLength(256);
		expect(renderer.closes).toHaveLength(0);
	});

	test("a row missing the strings the wire requires is answered, not thrown on", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({ harnesses: [], projects: [{ id: "p" } as never] }),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toEqual({ type: "registry", harnesses: [], projects: [{ id: "p", name: "", root: "" }] });
		expect(renderer.closes).toHaveLength(0);
	});

	test("an isDefault the port did not make a boolean does not throw on the way out", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => ({ harnesses: [{ id: "draht", isDefault: "yes" } as never], projects: [] }),
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toEqual({
			type: "registry",
			harnesses: [{ id: "draht", isDefault: false }],
			projects: [],
		});
		expect(renderer.closes).toHaveLength(0);
	});

	test("a bridge with no port answers an empty registry rather than closing the connection", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toEqual({ type: "registry", harnesses: [], projects: [] });
		expect(renderer.closes).toHaveLength(0);
	});

	test("a port that throws answers an empty registry rather than closing the connection", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			registry: () => {
				throw new Error("the registry file is unreadable");
			},
		});
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "registry_resync" }));

		expect(renderer.last()).toEqual({ type: "registry", harnesses: [], projects: [] });
		expect(renderer.closes).toHaveLength(0);
	});
});
