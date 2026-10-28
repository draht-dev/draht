import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_PARTIAL } from "../src/exit-codes.ts";
import { resolveDrahtToolsBin } from "../src/init.ts";
import { createDefaultState, loadState, saveState } from "../src/state.ts";
import { createWorld } from "./helpers/world.ts";

/** A stand-in for the draht-tools CLI that records exactly how it was invoked. */
function writeToolsStub(path: string, logPath: string, options: { exitCode?: number } = {}): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
fs.mkdirSync(require("node:path").join(process.cwd(), ".planning"), { recursive: true });
process.exit(${options.exitCode ?? 0});
`,
	);
}

interface InitWorld {
	world: ReturnType<typeof createWorld>;
	project: string;
	toolsLog: string;
	invocations: () => Array<{ argv: string[]; cwd: string }>;
	run: (
		argv: string[],
		overrides?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function initWorld(options: { toolsExitCode?: number; hosts?: string[] } = {}): InitWorld {
	const world = createWorld({ hosts: options.hosts ?? ["claude", "npm", "node"] });
	const project = join(world.home, "projects", "acme");
	const toolsBin = join(world.home, "draht-tools-stub.cjs");
	const toolsLog = join(world.home, "tools.log");
	mkdirSync(world.home, { recursive: true });
	writeToolsStub(toolsBin, toolsLog, { exitCode: options.toolsExitCode });

	return {
		world,
		project,
		toolsLog,
		invocations: () =>
			existsSync(toolsLog)
				? readFileSync(toolsLog, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
		run: (argv, overrides = {}) =>
			world.run(argv, {
				binName: "draht-init",
				env: { ...world.env, DRAHT_TOOLS_BIN: toolsBin },
				...overrides,
			}),
	};
}

describe("draht-tools resolution", () => {
	it("resolves the bundled draht-tools entry script from this package", () => {
		const resolved = resolveDrahtToolsBin({});

		expect(resolved).toMatch(/draht-tools\.cjs$/);
		expect(existsSync(resolved)).toBe(true);
	});

	it("honours an explicit override", () => {
		expect(resolveDrahtToolsBin({ DRAHT_TOOLS_BIN: "/custom/tools.cjs" })).toBe("/custom/tools.cjs");
	});
});

describe("draht-init", () => {
	it("refuses to scaffold without confirmation", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(existsSync(h.project)).toBe(false);
			expect(h.invocations()).toEqual([]);
		} finally {
			h.world.dispose();
		}
	});

	it("ensures components and scaffolds the project into a new directory", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project, "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(existsSync(join(h.project, ".planning"))).toBe(true);
			expect(loadState(h.world.root).components["claude-plugin"]).toBeDefined();

			const calls = h.invocations();
			expect(calls.map((call) => call.argv[0])).toEqual(["create-project", "init-state"]);
			expect(calls[0].argv).toEqual(["create-project", "acme"]);
			// Invoked through argv with the project as cwd — never through a shell. The child
			// reports its cwd canonicalised (macOS keeps temp dirs behind /private), so compare
			// real paths.
			expect(calls.every((call) => realpathSync(call.cwd) === realpathSync(h.project))).toBe(true);
		} finally {
			h.world.dispose();
		}
	});

	it("reports the agent handoff command instead of launching an agent", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project, "--yes"]);

			expect(run.stdout).toMatch(/next|handoff/i);
			expect(run.stdout).toContain(h.project);
			// Every host invocation is component management. An interactive agent
			// session would be a bare invocation or a non-management subcommand;
			// none is present, so init never launched one.
			for (const call of h.world.host.calls) {
				expect(call.args.length).toBeGreaterThan(0);
				expect(["plugin", "install", "uninstall"]).toContain(call.args[0]);
			}
		} finally {
			h.world.dispose();
		}
	});

	it("refuses a directory that already has unrelated contents", async () => {
		const h = initWorld();
		try {
			mkdirSync(h.project, { recursive: true });
			writeFileSync(join(h.project, "existing.txt"), "mine");

			const run = await h.run([h.project, "--yes"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/not empty|--force/i);
			expect(h.invocations()).toEqual([]);
			expect(readFileSync(join(h.project, "existing.txt"), "utf8")).toBe("mine");
		} finally {
			h.world.dispose();
		}
	});

	it("accepts a non-empty directory under --force", async () => {
		const h = initWorld();
		try {
			mkdirSync(h.project, { recursive: true });
			writeFileSync(join(h.project, "existing.txt"), "mine");

			const run = await h.run([h.project, "--yes", "--force"]);

			expect(run.code).toBe(EXIT_OK);
			expect(readFileSync(join(h.project, "existing.txt"), "utf8")).toBe("mine");
			expect(h.invocations().length).toBe(2);
		} finally {
			h.world.dispose();
		}
	});

	it("never overwrites an existing .planning tree, even with --force", async () => {
		const h = initWorld();
		try {
			mkdirSync(join(h.project, ".planning"), { recursive: true });
			writeFileSync(join(h.project, ".planning", "PROJECT.md"), "existing plan");

			const run = await h.run([h.project, "--yes", "--force"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/\.planning/);
			expect(readFileSync(join(h.project, ".planning", "PROJECT.md"), "utf8")).toBe("existing plan");
			expect(h.invocations()).toEqual([]);
		} finally {
			h.world.dispose();
		}
	});

	it("treats a bare git checkout as an acceptable empty directory", async () => {
		const h = initWorld();
		try {
			mkdirSync(join(h.project, ".git"), { recursive: true });

			const run = await h.run([h.project, "--yes"]);

			expect(run.code).toBe(EXIT_OK);
		} finally {
			h.world.dispose();
		}
	});

	it("writes nothing and calls nothing under --dry-run", async () => {
		const h = initWorld();
		try {
			const before = h.world.snapshotHome();
			const run = await h.run([h.project, "--yes", "--dry-run"]);

			expect(run.code).toBe(EXIT_OK);
			expect(h.world.snapshotHome()).toEqual(before);
			expect(h.invocations()).toEqual([]);
			expect(h.world.host.calls).toEqual([]);
			expect(existsSync(h.project)).toBe(false);
		} finally {
			h.world.dispose();
		}
	});

	it("fails when the scaffolder itself fails, and says which step", async () => {
		const h = initWorld({ toolsExitCode: 3 });
		try {
			const run = await h.run([h.project, "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(run.stderr).toMatch(/create-project|draht-tools/);
		} finally {
			h.world.dispose();
		}
	});

	it("honours explicit component selection", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project, "--yes", "--component", "claude-plugin"]);

			expect(run.code).toBe(EXIT_OK);
			expect(Object.keys(loadState(h.world.root).components)).toEqual(["claude-plugin"]);
		} finally {
			h.world.dispose();
		}
	});

	it("exits 3 with --fail-on-empty when no component resolves", async () => {
		const h = initWorld({ hosts: [] });
		try {
			const run = await h.run([h.project, "--yes", "--fail-on-empty"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(existsSync(h.project)).toBe(false);
		} finally {
			h.world.dispose();
		}
	});

	it("still scaffolds when no component resolves and the guard is not requested", async () => {
		const h = initWorld({ hosts: [] });
		try {
			const run = await h.run([h.project, "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(existsSync(join(h.project, ".planning"))).toBe(true);
		} finally {
			h.world.dispose();
		}
	});

	it("refuses to scaffold when an explicitly requested component plan is blocked", async () => {
		const h = initWorld();
		try {
			const state = createDefaultState();
			state.components["claude-plugin"] = {
				id: "claude-plugin",
				kind: "claude-plugin",
				version: "9999.1.1",
				source: { npmName: "draht-claude", resolvedVersion: "9999.1.1" },
				files: [],
				registered: true,
				effectiveness: "live",
			};
			saveState(h.world.root, state);

			const run = await h.run([h.project, "--yes", "--component", "claude-plugin"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/blocked|downgrade/i);
			expect(existsSync(h.project)).toBe(false);
			expect(h.invocations()).toEqual([]);
		} finally {
			h.world.dispose();
		}
	});

	it("emits NDJSON events only under --json", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project, "--yes", "--json"]);

			expect(run.code).toBe(EXIT_OK);
			const records = run.stdout
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line));
			expect(records.length).toBeGreaterThan(0);
			expect(records.some((record) => record.event === "summary")).toBe(true);
			expect(records.every((record) => record.command === "init")).toBe(true);
			expect(
				records.filter((record) => record.event === "scaffold-start").every((record) => Array.isArray(record.argv)),
			).toBe(true);
		} finally {
			h.world.dispose();
		}
	});

	it("rejects a second positional directory rather than guessing", async () => {
		const h = initWorld();
		try {
			const run = await h.run([h.project, "extra", "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
		} finally {
			h.world.dispose();
		}
	});
});

describe("draht-init against the real bundled draht-tools", () => {
	it("produces a real .planning tree", async () => {
		const world = createWorld({ hosts: [] });
		try {
			const project = join(world.home, "real-project");
			const run = await world.run([project, "--yes"], { binName: "draht-init" });

			expect(run.code).toBe(EXIT_OK);
			expect(existsSync(join(project, ".planning", "PROJECT.md"))).toBe(true);
			expect(existsSync(join(project, ".planning", "STATE.md"))).toBe(true);
		} finally {
			world.dispose();
		}
	});
});
