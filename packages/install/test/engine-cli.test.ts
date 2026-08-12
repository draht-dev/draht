import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CHANGES_PENDING, EXIT_ERROR, EXIT_OK, EXIT_PARTIAL } from "../src/exit-codes.ts";
import { acquireLock } from "../src/lock.ts";
import { loadState } from "../src/state.ts";
import { createPackageTarGz, createTarGz } from "./helpers/tar-fixture.ts";
import {
	CLAUDE_MARKETPLACE_REGISTERED,
	CLAUDE_PLUGIN_INSTALLED,
	claudeCleanUninstall,
	claudeHappyPath,
	createWorld,
} from "./helpers/world.ts";

/** Parses an NDJSON stream, asserting every line is a JSON object and nothing else leaked to stdout. */
function parseNdjson(stdout: string): Array<Record<string, unknown>> {
	return stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("plan", () => {
	it("exits 2 with the actions a fresh machine needs", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["plan", "--json"]);

			expect(run.code).toBe(EXIT_CHANGES_PENDING);
			const doc = JSON.parse(run.stdout);
			expect(doc.schemaVersion).toBe(1);
			expect(doc.command).toBe("plan");
			expect(doc.actions.map((action: { componentId: string }) => action.componentId).sort()).toEqual([
				"claude-plugin",
				"installer",
			]);
			expect(doc.channel).toBe("latest");
		} finally {
			world.dispose();
		}
	});

	it("omits plugin payloads for hosts that are not present", async () => {
		const world = createWorld({ hosts: ["npm"] });
		try {
			const doc = JSON.parse((await world.run(["plan", "--json"])).stdout);

			expect(doc.actions.map((action: { componentId: string }) => action.componentId)).toEqual(["installer"]);
			expect(doc.skipped.map((entry: { id: string }) => entry.id).sort()).toEqual(["claude-plugin", "codex-plugin"]);
		} finally {
			world.dispose();
		}
	});

	it("exits 3 when the resolved selection is empty and --fail-on-empty is given", async () => {
		const world = createWorld({ hosts: [] });
		try {
			const empty = await world.run(["plan"]);
			expect(empty.code).toBe(EXIT_OK);

			const guarded = await world.run(["plan", "--fail-on-empty"]);
			expect(guarded.code).toBe(EXIT_PARTIAL);
			expect(guarded.stderr).toMatch(/empty/i);
		} finally {
			world.dispose();
		}
	});

	it("rejects an unknown component selector", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["plan", "not-a-component"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(run.stderr).toContain("not-a-component");
		} finally {
			world.dispose();
		}
	});
});

describe("install", () => {
	it("refuses to mutate without a TTY and without --yes, writing nothing", async () => {
		const world = createWorld();
		try {
			const before = world.snapshotHome();
			const run = await world.run(["install"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/--yes|confirm/i);
			expect(world.snapshotHome()).toEqual(before);
			expect(world.host.calls).toEqual([]);
		} finally {
			world.dispose();
		}
	});

	it("proceeds when an interactive operator confirms", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install"], { isTTY: true, confirm: async () => true });

			expect(run.code).toBe(EXIT_OK);
			expect(existsSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"))).toBe(true);
		} finally {
			world.dispose();
		}
	});

	it("aborts when an interactive operator declines", async () => {
		const world = createWorld();
		try {
			const before = world.snapshotHome();
			const run = await world.run(["install"], { isTTY: true, confirm: async () => false });

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(world.snapshotHome()).toEqual(before);
		} finally {
			world.dispose();
		}
	});

	it("installs the payload, drives the host, and records durable state", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install", "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(readFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "utf8")).toContain(
				"draht-claude",
			);
			expect(existsSync(join(world.claudeTarget, ".claude-plugin", "marketplace.json"))).toBe(true);

			const state = loadState(world.root);
			expect(state.components["claude-plugin"].version).toBe("2026.8.1-1");
			expect(state.components["claude-plugin"].effectiveness).toBe("restart-required");
			expect(state.components["claude-plugin"].files.length).toBeGreaterThan(0);
			expect(state.components.installer.delegated).toEqual({
				method: "npm-global",
				packageName: "@draht/install",
			});
			expect(state.components.installer.files).toEqual([]);

			const commands = world.host.commandLines();
			expect(commands.some((line) => line.includes("plugin install draht@draht --scope user"))).toBe(true);
			expect(commands.some((line) => line.includes("npm install --global @draht/install@2026.8.1-1"))).toBe(true);
		} finally {
			world.dispose();
		}
	});

	it("is idempotent: a second install finds nothing to do", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--yes"]);
			const callsAfterFirst = world.host.calls.length;

			const second = await world.run(["install", "--yes"]);

			expect(second.code).toBe(EXIT_OK);
			expect(second.stdout).toMatch(/nothing to do|already up to date|no changes/i);
			expect(world.host.calls.length).toBe(callsAfterFirst);
		} finally {
			world.dispose();
		}
	});

	it("makes no writes, registry calls, downloads or host calls under --dry-run", async () => {
		const world = createWorld();
		try {
			const before = world.snapshotHome();
			const run = await world.run(["install", "--yes", "--dry-run"]);

			expect(run.code).toBe(EXIT_OK);
			expect(world.snapshotHome()).toEqual(before);
			expect(world.registryResolves).toEqual([]);
			expect(world.tarballFetches).toEqual([]);
			expect(world.host.calls).toEqual([]);
			expect(run.stdout).toMatch(/dry run|would/i);
		} finally {
			world.dispose();
		}
	});

	it("emits NDJSON events and no prose on stdout under --json", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install", "--yes", "--json"]);

			expect(run.code).toBe(EXIT_OK);
			const records = parseNdjson(run.stdout);
			expect(records.length).toBeGreaterThan(0);
			for (const record of records) {
				expect(record.schemaVersion).toBe(1);
				expect(typeof record.event).toBe("string");
			}
			expect(records.some((record) => record.event === "summary")).toBe(true);
		} finally {
			world.dispose();
		}
	});

	it("rolls back and leaves state untouched when the host refuses the install", async () => {
		const world = createWorld({
			responses: [
				...claudeHappyPath(),
				{ match: "plugin install draht@draht", respond: { status: 1, stderr: "host refused" } },
			],
		});
		try {
			const run = await world.run(["install", "claude-plugin", "--yes"]);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toContain("host refused");
			expect(run.stderr).toMatch(/host registration for claude-plugin may have changed.*reconcile/i);
			expect(existsSync(world.claudeTarget)).toBe(false);
			expect(loadState(world.root).components).toEqual({});
		} finally {
			world.dispose();
		}
	});

	it("restores the previous payload byte-for-byte when a re-install fails", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			const originalManifest = readFileSync(join(world.claudeTarget, ".claude-plugin", "marketplace.json"), "utf8");
			const originalPayload = readFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "utf8");

			// Force a reinstall whose host step fails.
			const failing = createWorld();
			failing.dispose();
			const run = await world.run(["install", "claude-plugin", "--yes", "--force"], {
				hostRunner: (file, args, opts) => {
					if (args.join(" ").includes("plugin install draht@draht")) {
						return { status: 1, stdout: "", stderr: "second install refused" };
					}
					return world.host.runner(file, args, opts);
				},
			});

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/host registration for claude-plugin may have changed.*reconcile/i);
			expect(readFileSync(join(world.claudeTarget, ".claude-plugin", "marketplace.json"), "utf8")).toBe(
				originalManifest,
			);
			expect(readFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "utf8")).toBe(originalPayload);
		} finally {
			world.dispose();
		}
	});

	it("refuses a payload whose own manifest is for a different package", async () => {
		const world = createWorld({
			// Integrity still matches — the registry really served these bytes — but
			// the payload identifies itself as something else entirely.
			tarballs: { "draht-claude": createPackageTarGz("totally-different-package", "2026.8.1-1") },
		});
		try {
			const run = await world.run(["install", "claude-plugin", "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(run.stderr).toMatch(/totally-different-package|identity/i);
			expect(existsSync(world.claudeTarget)).toBe(false);
			expect(loadState(world.root).components).toEqual({});
		} finally {
			world.dispose();
		}
	});

	it("refuses a payload whose own manifest declares a different version", async () => {
		const world = createWorld({
			tarballs: { "draht-claude": createPackageTarGz("draht-claude", "1.0.0-not-what-was-resolved") },
		});
		try {
			const run = await world.run(["install", "claude-plugin", "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(existsSync(world.claudeTarget)).toBe(false);
		} finally {
			world.dispose();
		}
	});

	it("refuses a payload with no manifest at all rather than trusting it", async () => {
		const world = createWorld({
			tarballs: { "draht-claude": createTarGz([{ path: "package/only-a-file.md", content: "x" }]) },
		});
		try {
			const run = await world.run(["install", "claude-plugin", "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(existsSync(world.claudeTarget)).toBe(false);
		} finally {
			world.dispose();
		}
	});

	it("refuses a malicious archive and writes nothing", async () => {
		const world = createWorld({
			tarballs: { "draht-claude": createTarGz([{ path: "package/../../escape.txt", content: "pwned" }]) },
		});
		try {
			const run = await world.run(["install", "claude-plugin", "--yes"]);

			expect(run.code).toBe(EXIT_ERROR);
			expect(existsSync(world.claudeTarget)).toBe(false);
			expect(loadState(world.root).components).toEqual({});
		} finally {
			world.dispose();
		}
	});

	it("refuses to run concurrently with another invocation holding the lock", async () => {
		const world = createWorld();
		try {
			mkdirSync(world.root, { recursive: true });
			const held = acquireLock(world.root, { command: "install" });
			try {
				const run = await world.run(["install", "--yes"]);

				expect(run.code).toBe(EXIT_PARTIAL);
				expect(run.stderr).toMatch(/already|lock/i);
				expect(world.host.calls).toEqual([]);
			} finally {
				held.release();
			}
		} finally {
			world.dispose();
		}
	});

	it("refuses to mutate when state.json is corrupt", async () => {
		const world = createWorld();
		try {
			mkdirSync(world.root, { recursive: true });
			writeFileSync(join(world.root, "state.json"), "{not json");

			const run = await world.run(["install", "--yes"]);

			expect(run.code).not.toBe(EXIT_OK);
			expect(run.stderr).toMatch(/state|corrupt/i);
			expect(world.host.calls).toEqual([]);
		} finally {
			world.dispose();
		}
	});
});

describe("status", () => {
	it("reports installed components and stays at exit 0 when clean", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--yes"]);

			const run = await world.run(["status", "--json", "--check"]);

			expect(run.code).toBe(EXIT_OK);
			const doc = JSON.parse(run.stdout);
			expect(doc.command).toBe("status");
			const claude = doc.components.find((entry: { id: string }) => entry.id === "claude-plugin");
			expect(claude.drift).toBe("clean");
			expect(claude.effectiveness).toBe("restart-required");
		} finally {
			world.dispose();
		}
	});

	it("detects on-disk drift and exits 2 under --check", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--yes"]);
			writeFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "tampered");

			const run = await world.run(["status", "--json", "--check"]);

			expect(run.code).toBe(EXIT_CHANGES_PENDING);
			const doc = JSON.parse(run.stdout);
			expect(doc.components.find((entry: { id: string }) => entry.id === "claude-plugin").drift).toBe("drifted");
		} finally {
			world.dispose();
		}
	});

	it("repairs drift on the next install", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--yes"]);
			writeFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "tampered");

			const run = await world.run(["install", "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(readFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "utf8")).toContain(
				"draht-claude",
			);
		} finally {
			world.dispose();
		}
	});

	it("never claims a component is clean when it has no catalog entry to verify against", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			// Simulate an engine downgrade: state records something this build has
			// no catalog entry (and therefore no target) for.
			const statePath = join(world.root, "state.json");
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			state.components["from-the-future"] = { ...state.components["claude-plugin"], id: "from-the-future" };
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const doc = JSON.parse((await world.run(["status", "--json"])).stdout);
			const entry = doc.components.find((component: { id: string }) => component.id === "from-the-future");

			expect(entry.drift).toBe("unknown");
			expect(entry.drift).not.toBe("clean");
		} finally {
			world.dispose();
		}
	});

	it("never prompts, even without a TTY", async () => {
		const world = createWorld();
		try {
			let prompted = false;
			const run = await world.run(["status"], {
				isTTY: true,
				confirm: async () => {
					prompted = true;
					return true;
				},
			});

			expect(run.code).toBe(EXIT_OK);
			expect(prompted).toBe(false);
		} finally {
			world.dispose();
		}
	});
});

describe("update", () => {
	it("applies a newer version published to the channel", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);

			const newer = createWorld({ versions: { "draht-claude": "2026.9.1-1" } });
			try {
				const run = await world.run(["update", "claude-plugin", "--yes"], { registry: newer.registry });

				expect(run.code).toBe(EXIT_OK);
				expect(loadState(world.root).components["claude-plugin"].version).toBe("2026.9.1-1");
			} finally {
				newer.dispose();
			}
		} finally {
			world.dispose();
		}
	});

	it("never silently downgrades", async () => {
		const world = createWorld({ versions: { "draht-claude": "2026.9.1-1" } });
		try {
			await world.run(["install", "claude-plugin", "--yes"]);

			const older = createWorld({ versions: { "draht-claude": "2026.1.1-1" } });
			try {
				const run = await world.run(["update", "claude-plugin", "--yes", "--json"], { registry: older.registry });

				expect(run.code).toBe(EXIT_PARTIAL);
				expect(loadState(world.root).components["claude-plugin"].version).toBe("2026.9.1-1");
				expect(run.stdout).toContain("downgrade");
			} finally {
				older.dispose();
			}
		} finally {
			world.dispose();
		}
	});
});

describe("uninstall", () => {
	it("removes the payload only after the host confirms deregistration", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);

			const run = await world.run(["uninstall", "claude-plugin", "--yes"], {
				hostRunner: createWorld({ responses: claudeCleanUninstall() }).host.runner,
			});

			expect(run.code).toBe(EXIT_OK);
			expect(existsSync(world.claudeTarget)).toBe(false);
			expect(loadState(world.root).components["claude-plugin"]).toBeUndefined();
		} finally {
			world.dispose();
		}
	});

	it("keeps the payload when the host still reports the plugin as registered", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			const stubborn = createWorld({
				responses: [
					{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_INSTALLED } },
					{ match: "plugin marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_REGISTERED } },
				],
			});

			try {
				const run = await world.run(["uninstall", "claude-plugin", "--yes"], { hostRunner: stubborn.host.runner });

				expect(run.code).not.toBe(EXIT_OK);
				expect(existsSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"))).toBe(true);
				expect(loadState(world.root).components["claude-plugin"]).toBeDefined();
			} finally {
				stubborn.dispose();
			}
		} finally {
			world.dispose();
		}
	});

	it("requires selectors or --all", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["uninstall", "--yes"]);
			expect(run.code).toBe(EXIT_ERROR);
			expect(run.stderr).toMatch(/--all|selector/i);
		} finally {
			world.dispose();
		}
	});
});

describe("doctor", () => {
	it("emits schema-stable findings as one JSON document", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["doctor", "--json"]);

			const doc = JSON.parse(run.stdout);
			expect(doc.schemaVersion).toBe(1);
			expect(doc.command).toBe("doctor");
			expect(Array.isArray(doc.findings)).toBe(true);
			for (const finding of doc.findings) {
				expect(typeof finding.id).toBe("string");
				expect(["info", "warn", "error"]).toContain(finding.severity);
				expect(typeof finding.message).toBe("string");
				expect(typeof finding.repairable).toBe("boolean");
			}
		} finally {
			world.dispose();
		}
	});

	it("reports legacy layouts, a missing host, and hash drift", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			writeFileSync(join(world.claudeTarget, "plugins", "draht", "plugin.md"), "tampered");
			mkdirSync(join(world.home, ".draht", ".git"), { recursive: true });
			mkdirSync(join(world.home, ".pi"), { recursive: true });

			const noHost = createWorld({ hosts: [] });
			try {
				const run = await world.run(["doctor", "--json"], { env: { ...world.env, PATH: noHost.binDir } });
				const ids = JSON.parse(run.stdout).findings.map((finding: { id: string }) => finding.id);

				expect(ids).toContain("legacy-curl-clone");
				expect(ids).toContain("legacy-pi-state");
				expect(ids).toContain("hash-drift:claude-plugin");
				expect(ids).toContain("host-missing:claude-plugin");
				expect(ids).toContain("npm-missing");
			} finally {
				noHost.dispose();
			}
		} finally {
			world.dispose();
		}
	});

	it("reports a crashed transaction and whether it can be recovered", async () => {
		const world = createWorld();
		try {
			mkdirSync(join(world.root, "backups", "tx-orphan", "alpha"), { recursive: true });

			const run = await world.run(["doctor", "--json"]);
			const findings = JSON.parse(run.stdout).findings as Array<{ id: string; repairable: boolean }>;
			const crashed = findings.find((finding) => finding.id.startsWith("crashed-transaction"));

			expect(crashed).toBeDefined();
			expect(crashed?.repairable).toBe(false);
		} finally {
			world.dispose();
		}
	});

	it("exits 0 on a clean machine and non-zero when an error-severity finding exists", async () => {
		const world = createWorld();
		try {
			expect((await world.run(["doctor"])).code).toBe(EXIT_OK);

			mkdirSync(join(world.root, "backups", "tx-orphan", "alpha"), { recursive: true });
			expect((await world.run(["doctor"])).code).not.toBe(EXIT_OK);
		} finally {
			world.dispose();
		}
	});
});

describe("interruption", () => {
	it("reports an interrupted apply as blocked, not as an internal error, and leaves nothing behind", async () => {
		const world = createWorld();
		try {
			const controller = new AbortController();
			controller.abort();

			const run = await world.run(["install", "--yes"], { signal: controller.signal });

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(run.stderr).toMatch(/interrupt/i);
			expect(existsSync(world.claudeTarget)).toBe(false);
			expect(loadState(world.root).components).toEqual({});
		} finally {
			world.dispose();
		}
	});
});

describe("crash recovery through the CLI", () => {
	it("refuses to mutate while an unrecoverable crashed transaction exists", async () => {
		const world = createWorld();
		try {
			mkdirSync(join(world.root, "backups", "tx-orphan", "alpha"), { recursive: true });

			const run = await world.run(["install", "--yes"]);

			expect(run.code).not.toBe(EXIT_OK);
			expect(run.stderr).toMatch(/tx-orphan|doctor/i);
			expect(world.host.calls).toEqual([]);
		} finally {
			world.dispose();
		}
	});
});
