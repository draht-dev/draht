/** R36-SPAWN.1 — two registry ids become one running session, one refusal, or nothing at all. */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttachBridgeOptions } from "@draht/geist-core";
import type { GeistConfig, SessionSpawnCode } from "@draht/geist-protocol";
import { SessionLauncher, type SessionLaunchPort } from "../session/session-launcher.js";
import {
	type SessionLaunchRequest,
	SessionSpawner,
	type SpawnOutcome,
	type SpawnRefusalCode,
	SpawnRefusedError,
} from "../session/spawn-primitive.js";

const cleanup: string[] = [];

/** /tmp and /var are root-owned symlinks the resolver's walk exempts by design; under /private/tmp the rule is tested. */
function tempRoot(prefix: string): string {
	const dir = realpathSync(mkdtempSync(`/private/tmp/${prefix}`));
	cleanup.push(dir);
	return dir;
}

function program(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

function directory(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

function registry(cmd: string, root: string, overrides: Partial<GeistConfig> = {}): GeistConfig {
	return {
		harness: { default: "draht", agents: { draht: { cmd } } },
		projects: { fr3n: { root } },
		...overrides,
	};
}

interface Recorder extends SessionLaunchPort {
	requests: SessionLaunchRequest[];
}

function recordingSpawner(respond: (request: SessionLaunchRequest) => Promise<SpawnOutcome>): Recorder {
	const requests: SessionLaunchRequest[] = [];
	return {
		requests,
		launch(request: SessionLaunchRequest): Promise<SpawnOutcome> {
			requests.push(request);
			return respond(request);
		},
	};
}

function accepting(pid = 4242): Recorder {
	return recordingSpawner(() => Promise.resolve({ pid }));
}

function refusing(code: SpawnRefusalCode, message: string): Recorder {
	return recordingSpawner(() => Promise.reject(new SpawnRefusedError(code, message)));
}

/** A world where both ids resolve: a real executable, a real project root, and a spawner that says yes. */
function world(prefix: string, overrides: Partial<GeistConfig> = {}) {
	const base = tempRoot(prefix);
	const cmd = program(join(base, "bin", "agent"));
	const root = directory(join(base, "work", "fr3n"));
	const config = registry(cmd, root, overrides);
	return { base, cmd, root, config };
}

afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("an id that does not resolve starts no process", () => {
	test("an unknown harness", async () => {
		const { config } = world("sl-uh-");
		const spawner = accepting();

		const outcome = await new SessionLauncher({ spawner, registry: () => config }).launch("gemini", "fr3n");

		expect(outcome.code).toBe("unknown_harness");
		expect(outcome.sessionId).toBeUndefined();
		expect(spawner.requests).toHaveLength(0);
	});

	test("an unknown project", async () => {
		const { config } = world("sl-up-");
		const spawner = accepting();

		const outcome = await new SessionLauncher({ spawner, registry: () => config }).launch("draht", "other");

		expect(outcome.code).toBe("unknown_project");
		expect(outcome.sessionId).toBeUndefined();
		expect(spawner.requests).toHaveLength(0);
	});

	test("an executable outside every approved root", async () => {
		const approved = tempRoot("sl-appr-");
		const { config } = world("sl-out-", { approvedRoots: [approved] });
		const spawner = accepting();

		const outcome = await new SessionLauncher({ spawner, registry: () => config }).launch("draht", "fr3n");

		expect(outcome.code).toBe("refused");
		expect(outcome.message).toContain("not inside an approved root");
		expect(outcome.sessionId).toBeUndefined();
		expect(spawner.requests).toHaveLength(0);
	});

	test("the ownership walk runs as the uid the launcher was given", async () => {
		const { config } = world("sl-uid-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config, uid: 65534 });

		const outcome = await launcher.launch("draht", "fr3n");

		expect(outcome.code).toBe("refused");
		expect(outcome.message).toContain("not owned by this user");
		expect(spawner.requests).toHaveLength(0);
	});

	test("a forbidden root the launcher was given is forbidden here", async () => {
		const { base, config } = world("sl-forb-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config, forbiddenRoots: [base] });

		const outcome = await launcher.launch("draht", "fr3n");

		expect(outcome.code).toBe("refused");
		expect(outcome.message).toContain("forbidden root");
		expect(spawner.requests).toHaveLength(0);
	});

	test("a harness the resolver would not spawn is not spawnable here either", async () => {
		const { config } = world("sl-nsp-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config, spawnableHarnessIds: ["gemini"] });

		expect((await launcher.launch("draht", "fr3n")).code).toBe("unknown_harness");
		expect(spawner.requests).toHaveLength(0);
	});
});

describe("a resolved pair reaches the spawner unchanged", () => {
	test("the minted id is what was spawned and what comes back", async () => {
		const { config } = world("sl-ok-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config, mintSessionId: () => "minted-0001" });

		const outcome = await launcher.launch("draht", "fr3n");

		expect(outcome).toEqual({ code: "spawned", sessionId: "minted-0001" });
		expect(spawner.requests[0]?.sessionId).toBe("minted-0001");
	});

	test("the executable, the leading args, the root and the credentials are the resolver's", async () => {
		const { config, root } = world("sl-fwd-");
		const script = program(join(dirname(root), "bin", "agent.js"));
		config.harness.agents.draht = { cmd: script, args: ["--acp"], credentialEnv: ["ANTHROPIC_API_KEY"] };
		const spawner = accepting();

		await new SessionLauncher({ spawner, registry: () => config, mintSessionId: () => "m2" }).launch("draht", "fr3n");

		expect(spawner.requests[0]).toEqual({
			sessionId: "m2",
			executable: realpathSync(process.execPath),
			leadingArgs: [script, "--acp"],
			projectRoot: root,
			credentialEnv: ["ANTHROPIC_API_KEY"],
		});
	});

	test("a harness that declares no credentials receives none", async () => {
		const { config } = world("sl-nocred-");
		const spawner = accepting();

		await new SessionLauncher({ spawner, registry: () => config }).launch("draht", "fr3n");

		expect(spawner.requests[0]?.credentialEnv).toEqual([]);
	});
});

describe("every spawn refusal has one documented wire code", () => {
	const table: readonly [SpawnRefusalCode, SessionSpawnCode][] = [
		["refused", "refused"],
		["spawn_failed", "spawn_failed"],
		["timeout", "timeout"],
		["cwd_missing", "refused"],
		["already_live", "refused"],
	];

	for (const [refusal, wire] of table) {
		test(`${refusal} is answered ${wire}`, async () => {
			const { config } = world(`sl-${refusal}-`);
			const spawner = refusing(refusal, `the spawner said ${refusal}`);
			const launcher = new SessionLauncher({ spawner, registry: () => config, mintSessionId: () => "m3" });

			const outcome = await launcher.launch("draht", "fr3n");

			expect(outcome.code).toBe(wire);
			expect(outcome.message).toBe(`the spawner said ${refusal}`);
			expect(outcome.sessionId).toBeUndefined();
			expect(spawner.requests).toHaveLength(1);
		});
	}

	test("an error that is not a refusal is not translated into one", async () => {
		const { config } = world("sl-throw-");
		const spawner = recordingSpawner(() => Promise.reject(new Error("the socket directory vanished")));
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		await expect(launcher.launch("draht", "fr3n")).rejects.toThrow("the socket directory vanished");
		expect(spawner.requests).toHaveLength(1);
	});
});

describe("one pair, one spawn in flight, daemon-wide", () => {
	test("the second asker is refused and nothing is spawned twice", async () => {
		const { config } = world("sl-race-");
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const spawner = recordingSpawner(async () => {
			await gate;
			return { pid: 7 };
		});
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		const first = launcher.launch("draht", "fr3n");
		const second = launcher.launch("draht", "fr3n");
		// Both bodies have run to their first await already: a claim taken after one would show two requests here.
		expect(spawner.requests).toHaveLength(1);

		const refused = await second;
		expect(refused.code).toBe("refused");
		expect(refused.sessionId).toBeUndefined();
		expect(refused.message).toContain("already in flight");

		release();
		expect((await first).code).toBe("spawned");
	});

	test("a different pair in flight at the same time is not refused", async () => {
		const { base, config } = world("sl-two-");
		config.projects = { fr3n: config.projects?.fr3n ?? { root: base }, other: { root: directory(join(base, "o")) } };
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const spawner = recordingSpawner(async () => {
			await gate;
			return { pid: 8 };
		});
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		const first = launcher.launch("draht", "fr3n");
		const second = launcher.launch("draht", "other");
		release();

		expect((await first).code).toBe("spawned");
		expect((await second).code).toBe("spawned");
		expect(spawner.requests).toHaveLength(2);
	});

	test("two pairs that would concatenate to one key are still two pairs", async () => {
		const base = tempRoot("sl-sep-");
		const config: GeistConfig = {
			harness: { default: "c", agents: { "b.c": { cmd: program(join(base, "bin", "bc")) } } },
			projects: { a: { root: directory(join(base, "a")) } },
		};
		config.harness.agents.c = { cmd: program(join(base, "bin", "c")) };
		config.projects = { ...config.projects, "a.b": { root: directory(join(base, "ab")) } };
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const spawner = recordingSpawner(async () => {
			await gate;
			return { pid: 9 };
		});
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		const first = launcher.launch("b.c", "a");
		const second = launcher.launch("c", "a.b");
		release();

		expect((await first).code).toBe("spawned");
		expect((await second).code).toBe("spawned");
	});

	test("the pair is launchable again after a failure", async () => {
		const { config } = world("sl-rel-");
		const spawner = refusing("spawn_failed", "the child died");
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		expect((await launcher.launch("draht", "fr3n")).code).toBe("spawn_failed");
		expect((await launcher.launch("draht", "fr3n")).code).toBe("spawn_failed");
		expect(spawner.requests).toHaveLength(2);
	});

	test("a resolver refusal does not wedge the pair either", async () => {
		const { config, cmd, root } = world("sl-relres-");
		config.harness.agents = {};
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		expect((await launcher.launch("draht", "fr3n")).code).toBe("unknown_harness");
		config.harness.agents = { draht: { cmd } };
		expect((await launcher.launch("draht", "fr3n")).code).toBe("spawned");
		expect(spawner.requests[0]?.projectRoot).toBe(root);
	});
});

describe("the registry is asked, never remembered", () => {
	test("every launch and every snapshot reads it again", async () => {
		const { config } = world("sl-count-");
		let reads = 0;
		const spawner = accepting();
		const launcher = new SessionLauncher({
			spawner,
			registry: () => {
				reads += 1;
				return config;
			},
		});

		expect(reads).toBe(0);
		await launcher.launch("draht", "fr3n");
		expect(reads).toBe(1);
		await launcher.launch("draht", "fr3n");
		expect(reads).toBe(2);
		launcher.snapshot();
		expect(reads).toBe(3);
		launcher.snapshot();
		expect(reads).toBe(4);
	});

	test("a project root edited between two launches is seen by the second", async () => {
		const { base, config, root } = world("sl-edit-");
		const moved = directory(join(base, "work", "moved"));
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		await launcher.launch("draht", "fr3n");
		config.projects = { fr3n: { root: moved } };
		await launcher.launch("draht", "fr3n");

		expect(spawner.requests.map((request) => request.projectRoot)).toEqual([root, moved]);
	});

	test("a harness added after construction is launchable without one", async () => {
		const { base, config } = world("sl-added-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		expect((await launcher.launch("gemini", "fr3n")).code).toBe("unknown_harness");
		config.harness.agents.gemini = { cmd: program(join(base, "bin", "gemini")) };
		expect((await launcher.launch("gemini", "fr3n")).code).toBe("spawned");
	});
});

describe("a minted id that is not id-shaped is refused, not repaired", () => {
	for (const minted of ["../etc", "-rf", "", "a b"]) {
		test(`the real spawner refuses ${JSON.stringify(minted)} before anything runs`, async () => {
			const { config } = world("sl-mint-");
			const agentDir = tempRoot("sl-agent-");
			const spawner = new SessionSpawner({ agentDir, socketDir: join(agentDir, "sockets") });
			const launcher = new SessionLauncher({ spawner, registry: () => config, mintSessionId: () => minted });

			const outcome = await launcher.launch("draht", "fr3n");

			expect(outcome.code).toBe("refused");
			expect(outcome.message).toContain("not id-shaped");
			expect(outcome.sessionId).toBeUndefined();
		});
	}

	test("a refused resolve burns no id", async () => {
		const { config } = world("sl-burn-");
		let minted = 0;
		const spawner = accepting();
		const launcher = new SessionLauncher({
			spawner,
			registry: () => config,
			mintSessionId: () => {
				minted += 1;
				return `m${minted}`;
			},
		});

		expect((await launcher.launch("gemini", "fr3n")).code).toBe("unknown_harness");
		expect(minted).toBe(0);
		expect((await launcher.launch("draht", "fr3n")).sessionId).toBe("m1");
	});

	test("a real uuid is not refused", async () => {
		const { config } = world("sl-uuid-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config });

		const outcome = await launcher.launch("draht", "fr3n");

		expect(outcome.code).toBe("spawned");
		expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("the snapshot offers what the resolver would accept", () => {
	test("the default is marked, a nameless project falls back to its id, and no cmd is offered", () => {
		const { base, config, cmd } = world("sl-snap-");
		config.harness.agents.gemini = { cmd };
		config.projects = { fr3n: { root: base, name: "fr3n tech" }, bare: { root: base } };
		const launcher = new SessionLauncher({ spawner: accepting(), registry: () => config });

		const snapshot = launcher.snapshot();

		expect(snapshot.harnesses).toEqual([
			{ id: "draht", isDefault: true },
			{ id: "gemini", isDefault: false },
		]);
		expect(snapshot.projects).toEqual([
			{ id: "fr3n", name: "fr3n tech", root: base },
			{ id: "bare", name: "bare", root: base },
		]);
		expect(JSON.stringify(snapshot)).not.toContain(cmd);
	});

	test("a harness the launcher would refuse is not offered", () => {
		const { config, cmd } = world("sl-snapf-");
		config.harness.agents.gemini = { cmd };
		const launcher = new SessionLauncher({
			spawner: accepting(),
			registry: () => config,
			spawnableHarnessIds: ["gemini"],
		});

		expect(launcher.snapshot().harnesses).toEqual([{ id: "gemini", isDefault: false }]);
	});

	test("a registry that cannot be read throws rather than answering empty", () => {
		const launcher = new SessionLauncher({
			spawner: accepting(),
			registry: () => {
				throw new Error("permissions on the registry file changed");
			},
		});

		expect(() => launcher.snapshot()).toThrow("permissions on the registry file changed");
	});
});

describe("the launcher fits the ports wave 4 will hand the bridge", () => {
	test("its two methods are a SpawnSessionPort and a RegistryPort", async () => {
		const { config, root } = world("sl-port-");
		const spawner = accepting();
		const launcher = new SessionLauncher({ spawner, registry: () => config, mintSessionId: () => "m4" });
		// Assignability is the assertion: a drift between these shapes and the bridge's is a compile error here.
		const ports: Pick<AttachBridgeOptions, "spawnSession" | "registry"> = {
			spawnSession: (request) => launcher.launch(request.harnessId, request.projectId),
			registry: () => launcher.snapshot(),
		};

		expect(await ports.spawnSession?.({ harnessId: "draht", projectId: "fr3n" })).toEqual({
			code: "spawned",
			sessionId: "m4",
		});
		expect(ports.registry?.().projects).toEqual([{ id: "fr3n", name: "fr3n", root }]);
	});
});
