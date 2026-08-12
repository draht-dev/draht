import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256File } from "../../src/hash.ts";
import { extractTarGz } from "../../src/sources/tar.ts";
import { packageRoot } from "../../src/version.ts";
import { type FixtureRegistry, startFixtureRegistry } from "../helpers/registry.ts";
import { createPackageTarGz, createTarGz } from "../helpers/tar-fixture.ts";

const PKG_ROOT = packageRoot();
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version as string;

let workspace: string;
let installed: string;
let binDir: string;
let registry: FixtureRegistry;
/** Same packages, but `latest` has moved on — used to prove `update` really upgrades. */
let updatedRegistry: FixtureRegistry;
let maliciousRegistry: FixtureRegistry;
let gitStatusBefore: string;

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs a child process **asynchronously**.
 *
 * This is load-bearing, not stylistic: the fixture registry is an HTTP server
 * living in this same process, so a synchronous spawn would block the event
 * loop and the child could never be served. Every subprocess in this file is
 * awaited for that reason.
 */
function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: env ?? process.env });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

/**
 * A stand-in host CLI that behaves like a real one: it records every argv and
 * keeps its own registration state, so `plugin list --json` answers differently
 * before and after an install. The lifecycle below therefore exercises the
 * adapter's real branching rather than a fixed script.
 */
function writeHostStub(path: string, host: "claude" | "codex", statePath: string, logPath: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ host: ${JSON.stringify(host)}, args, cwd: process.cwd(), home: process.env.HOME }) + "\\n");

const statePath = ${JSON.stringify(statePath)};
function load() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { registered: false, installed: false, enabled: false }; }
}
function save(s) { fs.writeFileSync(statePath, JSON.stringify(s)); }
const s = load();
const line = args.join(" ");

if (line === "plugin marketplace list --json") {
  const entries = s.registered ? [{ name: "draht" }] : [];
  process.stdout.write(${JSON.stringify(host)} === "codex" ? JSON.stringify({ marketplaces: entries }) : JSON.stringify(entries));
  process.exit(0);
}
if (line === "plugin list --json") {
  const entries = s.installed ? [{ name: "draht", marketplace: "draht", enabled: s.enabled !== false }] : [];
  process.stdout.write(${JSON.stringify(host)} === "codex" ? JSON.stringify({ installed: entries }) : JSON.stringify(entries));
  process.exit(0);
}
if (line.startsWith("plugin marketplace add")) { s.registered = true; save(s); process.exit(0); }
if (line.startsWith("plugin marketplace update")) { process.exit(s.registered ? 0 : 1); }
if (line.startsWith("plugin marketplace remove")) { s.registered = false; save(s); process.exit(0); }
if (line.startsWith("plugin validate")) { process.exit(0); }
if (line.startsWith("plugin install") || line.startsWith("plugin add")) { s.installed = true; s.enabled = true; save(s); process.exit(0); }
if (line.startsWith("plugin uninstall") || line.startsWith("plugin remove")) { s.installed = false; s.enabled = false; save(s); process.exit(0); }
if (line.startsWith("plugin enable")) { s.enabled = true; save(s); process.exit(0); }
if (line.startsWith("plugin disable")) { s.enabled = false; save(s); process.exit(0); }
process.exit(0);
`,
	);
	chmodSync(path, 0o755);
}

/** A stub npm that records global installs instead of performing them. */
function writeNpmStub(path: string, logPath: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
"use strict";
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ host: "npm", args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(0);
`,
	);
	chmodSync(path, 0o755);
}

interface Harness {
	home: string;
	logPath: string;
	env: NodeJS.ProcessEnv;
	dispose: () => void;
	cli: (bin: "draht-install" | "draht-init", args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<RunResult>;
	hostCalls: () => Array<{ host: string; args: string[]; cwd: string; home?: string }>;
	snapshot: () => Record<string, string>;
}

function makeHarness(registryUrl: string = registry.url): Harness {
	const base = mkdtempSync(join(tmpdir(), "draht-e2e-"));
	const home = join(base, "home");
	const hostBin = join(base, "hostbin");
	const logPath = join(base, "host.log");
	mkdirSync(home, { recursive: true });
	mkdirSync(hostBin, { recursive: true });
	writeFileSync(logPath, "");
	writeHostStub(join(hostBin, "claude"), "claude", join(base, "claude-state.json"), logPath);
	writeHostStub(join(hostBin, "codex"), "codex", join(base, "codex-state.json"), logPath);
	writeNpmStub(join(hostBin, "npm"), logPath);
	symlinkSync(process.execPath, join(hostBin, "node"));

	const env: NodeJS.ProcessEnv = {
		PATH: `${hostBin}:${dirname(process.execPath)}`,
		HOME: home,
		DRAHT_HOME: home,
		DRAHT_REGISTRY: registryUrl,
	};

	return {
		home,
		logPath,
		env,
		dispose: () => rmSync(base, { recursive: true, force: true }),
		cli: (bin, args, extraEnv) => run(process.execPath, [join(binDir, bin), ...args], home, { ...env, ...extraEnv }),
		hostCalls: () =>
			readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		snapshot: () => {
			const result: Record<string, string> = {};
			const walk = (dir: string): void => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, entry.name);
					if (entry.isSymbolicLink()) {
						result[relative(home, full)] = "symlink";
					} else if (entry.isDirectory()) {
						walk(full);
					} else if (entry.isFile()) {
						result[relative(home, full)] = readFileSync(full, "utf8");
					}
				}
			};
			walk(home);
			return result;
		},
	};
}

beforeAll(async () => {
	gitStatusBefore = (await run("git", ["status", "--porcelain"], REPO_ROOT)).stdout;

	// Build exactly what the package's build script builds, invoking its two
	// constituent commands directly.
	const build = await run("npx", ["tsc", "-p", "tsconfig.build.json"], PKG_ROOT);
	expect(build.status, `tsc failed: ${build.stdout}${build.stderr}`).toBe(0);
	const chmod = await run("npx", ["shx", "chmod", "+x", "dist/cli.js"], PKG_ROOT);
	expect(chmod.status, `chmod failed: ${chmod.stdout}${chmod.stderr}`).toBe(0);

	workspace = mkdtempSync(join(tmpdir(), "draht-pack-"));
	const pack = await run("npm", ["pack", "--pack-destination", workspace], PKG_ROOT);
	expect(pack.status, `npm pack failed: ${pack.stdout}${pack.stderr}`).toBe(0);
	const tarballName = readdirSync(workspace).find((entry) => entry.endsWith(".tgz"));
	expect(tarballName).toBeDefined();

	// Extract with the engine's own reader: a tarball it cannot read is one it
	// could not install either.
	installed = join(workspace, "installed");
	extractTarGz(readFileSync(join(workspace, tarballName as string)), installed);

	// Dependencies resolve from the real package's node_modules; nothing is
	// downloaded and no global install happens.
	symlinkSync(join(PKG_ROOT, "node_modules"), join(installed, "node_modules"));

	// npm links bins by basename; reproduce that so basename dispatch is what
	// actually selects the surface.
	binDir = join(workspace, "bin");
	mkdirSync(binDir, { recursive: true });
	for (const bin of ["draht-install", "draht-init"]) {
		symlinkSync(join(installed, "dist", "cli.js"), join(binDir, bin));
	}

	registry = await startFixtureRegistry(
		["draht-claude", "draht-codex", "@draht/coding-agent", "@draht/install"].map((name) => ({
			name,
			distTags: { latest: "2026.8.1-1" },
			versions: [
				{
					version: "2026.8.1-1",
					tarball: createPackageTarGz(name, "2026.8.1-1", { "plugin.md": `payload ${name}` }),
				},
				{
					version: "2026.9.9-1",
					tarball: createPackageTarGz(name, "2026.9.9-1", { "plugin.md": `payload ${name} v2` }),
				},
			],
		})),
	);

	updatedRegistry = await startFixtureRegistry(
		["draht-claude", "draht-codex", "@draht/coding-agent", "@draht/install"].map((name) => ({
			name,
			distTags: { latest: "2026.9.9-1" },
			versions: [
				{
					version: "2026.9.9-1",
					tarball: createPackageTarGz(name, "2026.9.9-1", { "plugin.md": `payload ${name} v2` }),
				},
			],
		})),
	);

	maliciousRegistry = await startFixtureRegistry([
		{
			name: "draht-claude",
			distTags: { latest: "2026.8.1-1" },
			versions: [
				{ version: "2026.8.1-1", tarball: createTarGz([{ path: "package/../../escape.txt", content: "pwned" }]) },
			],
		},
	]);
}, 600_000);

afterAll(async () => {
	await registry?.close();
	await updatedRegistry?.close();
	await maliciousRegistry?.close();
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("packed tarball", () => {
	it("ships both bins pointing at the built cli", async () => {
		const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

		expect(manifest.bin).toEqual({ "draht-install": "./dist/cli.js", "draht-init": "./dist/cli.js" });
		expect(existsSync(join(installed, "dist", "cli.js"))).toBe(true);
		expect(readFileSync(join(installed, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
	});

	it("stays private until publication is authorized", async () => {
		expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).private).toBe(true);
	});

	it("leaves the built entry executable", async () => {
		// eslint-disable-next-line no-bitwise -- POSIX mode bits are a bitfield.
		expect(statSync(join(PKG_ROOT, "dist", "cli.js")).mode & 0o111).not.toBe(0);
	});

	it("ships the README and CHANGELOG the manifest promises", async () => {
		expect(existsSync(join(installed, "README.md"))).toBe(true);
		expect(existsSync(join(installed, "CHANGELOG.md"))).toBe(true);
	});
});

describe("basename dispatch from the packed bins", () => {
	it("serves draht-install help and version", async () => {
		const h = makeHarness();
		try {
			const help = await h.cli("draht-install", ["--help"]);
			expect(help.status).toBe(0);
			expect(help.stdout).toContain("draht-install");
			expect(help.stdout).toContain("uninstall");

			const version = await h.cli("draht-install", ["--version"]);
			expect(version.status).toBe(0);
			expect(version.stdout.trim()).toBe(VERSION);
		} finally {
			h.dispose();
		}
	});

	it("serves the draht-init surface from the other bin name", async () => {
		const h = makeHarness();
		try {
			const help = await h.cli("draht-init", ["--help"]);

			expect(help.status).toBe(0);
			expect(help.stdout).toContain("draht-init");
			expect(help.stdout).not.toContain("uninstall");
		} finally {
			h.dispose();
		}
	});
});

describe("full lifecycle against a fake HOME, PATH and registry", () => {
	it("runs plan -> install -> status -> drift -> doctor -> update -> uninstall", async () => {
		const h = makeHarness();
		try {
			const marketplace = join(h.home, ".draht", "claude-marketplace");

			// plan: changes pending
			const plan = await h.cli("draht-install", ["plan", "--json"]);
			expect(plan.status).toBe(2);
			const planDoc = JSON.parse(plan.stdout);
			expect(planDoc.schemaVersion).toBe(1);
			expect(planDoc.actions.map((a: { componentId: string }) => a.componentId).sort()).toEqual([
				"claude-plugin",
				"codex-plugin",
				"installer",
			]);

			// install
			const install = await h.cli("draht-install", ["install", "--yes"]);
			expect(install.status, install.stderr).toBe(0);
			expect(readFileSync(join(marketplace, "plugins", "draht", "plugin.md"), "utf8")).toContain("draht-claude");
			expect(existsSync(join(marketplace, ".claude-plugin", "marketplace.json"))).toBe(true);
			expect(existsSync(join(h.home, ".draht", "codex-marketplace", ".agents", "plugins", "marketplace.json"))).toBe(
				true,
			);

			// The host was driven through argv with the fake HOME.
			const claudeCalls = h.hostCalls().filter((call) => call.host === "claude");
			expect(claudeCalls.some((call) => call.args.join(" ") === "plugin install draht@draht --scope user")).toBe(
				true,
			);
			expect(claudeCalls.every((call) => call.home === h.home)).toBe(true);
			expect(h.hostCalls().some((call) => call.host === "npm" && call.args[0] === "install")).toBe(true);

			// status: clean, exit 0 even under --check
			const status = await h.cli("draht-install", ["status", "--json", "--check"]);
			expect(status.status).toBe(0);
			expect(JSON.parse(status.stdout).components.every((c: { drift: string }) => c.drift !== "drifted")).toBe(true);

			// idempotent install
			const again = await h.cli("draht-install", ["install", "--yes"]);
			expect(again.status).toBe(0);
			expect(again.stdout).toMatch(/nothing to do/i);

			// drift
			writeFileSync(join(marketplace, "plugins", "draht", "plugin.md"), "tampered");
			const drifted = await h.cli("draht-install", ["status", "--json", "--check"]);
			expect(drifted.status).toBe(2);

			// doctor sees the drift
			const doctor = await h.cli("draht-install", ["doctor", "--json"]);
			const ids = JSON.parse(doctor.stdout).findings.map((f: { id: string }) => f.id);
			expect(ids).toContain("hash-drift:claude-plugin");

			// install repairs it
			expect((await h.cli("draht-install", ["install", "--yes"])).status).toBe(0);
			expect(readFileSync(join(marketplace, "plugins", "draht", "plugin.md"), "utf8")).toContain("draht-claude");

			// update: point at a registry whose `latest` has moved on, and prove
			// the newer payload actually replaced the old one.
			const update = await h.cli("draht-install", ["update", "--yes"], { DRAHT_REGISTRY: updatedRegistry.url });
			expect(update.status, update.stderr).toBe(0);
			expect(readFileSync(join(marketplace, "plugins", "draht", "plugin.md"), "utf8")).toContain("v2");
			const afterUpdate = JSON.parse((await h.cli("draht-install", ["status", "--json"])).stdout);
			expect(afterUpdate.components.find((c: { id: string }) => c.id === "claude-plugin").version).toBe(
				"2026.9.9-1",
			);

			// uninstall removes the payload once the host confirms deregistration
			const uninstall = await h.cli("draht-install", ["uninstall", "--all", "--yes"]);
			expect(uninstall.status, uninstall.stderr).toBe(0);
			expect(existsSync(marketplace)).toBe(false);

			const finalStatus = JSON.parse((await h.cli("draht-install", ["status", "--json"])).stdout);
			expect(finalStatus.components).toEqual([]);
		} finally {
			h.dispose();
		}
	}, 300_000);

	it("leaves the fake HOME byte-clean except the declared state root and payload targets", async () => {
		const h = makeHarness();
		try {
			expect((await h.cli("draht-install", ["install", "--yes"])).status).toBe(0);

			const paths = Object.keys(h.snapshot());
			const undeclared = paths.filter(
				(path) =>
					!path.startsWith(join(".draht", "install")) &&
					!path.startsWith(join(".draht", "claude-marketplace")) &&
					!path.startsWith(join(".draht", "codex-marketplace")),
			);

			expect(undeclared).toEqual([]);
		} finally {
			h.dispose();
		}
	}, 300_000);

	it("refuses to mutate without a TTY and without --yes", async () => {
		const h = makeHarness();
		try {
			const before = h.snapshot();
			const result = await h.cli("draht-install", ["install"]);

			expect(result.status).toBe(3);
			expect(result.stderr).toMatch(/--yes|confirm/i);
			expect(h.snapshot()).toEqual(before);
			expect(h.hostCalls()).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	it("writes not one byte and calls nothing under --dry-run", async () => {
		const h = makeHarness();
		try {
			const before = h.snapshot();
			const requestsBefore = registry.requests.length;

			const result = await h.cli("draht-install", ["install", "--yes", "--dry-run"]);

			expect(result.status).toBe(0);
			// Byte-identical HOME, no host process, and no registry request of any
			// kind. The preview uses durable local state and a symbolic `latest`.
			expect(h.snapshot()).toEqual(before);
			expect(h.hostCalls()).toEqual([]);
			expect(registry.requests.length).toBe(requestsBefore);
		} finally {
			h.dispose();
		}
	});

	it("emits parseable JSON for every read command and NDJSON for mutations", async () => {
		const h = makeHarness();
		try {
			for (const args of [
				["plan", "--json"],
				["status", "--json"],
				["doctor", "--json"],
			]) {
				const result = await h.cli("draht-install", args);
				expect(() => JSON.parse(result.stdout)).not.toThrow();
				expect(JSON.parse(result.stdout).schemaVersion).toBe(1);
			}

			const install = await h.cli("draht-install", ["install", "--yes", "--json"]);
			const records = install.stdout
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line));
			expect(records.length).toBeGreaterThan(0);
			expect(records.every((record) => record.schemaVersion === 1)).toBe(true);
		} finally {
			h.dispose();
		}
	}, 300_000);

	it("keeps prose off stdout when a JSON command fails", async () => {
		const h = makeHarness();
		try {
			const result = await h.cli("draht-install", ["install", "nonexistent-component", "--yes", "--json"]);

			expect(result.status).toBe(1);
			const doc = JSON.parse(result.stdout);
			expect(doc.ok).toBe(false);
			expect(doc.error.code).toBe("usage");
		} finally {
			h.dispose();
		}
	});

	it("refuses a malicious archive and writes nothing", async () => {
		const h = makeHarness(maliciousRegistry.url);
		try {
			const result = await h.cli("draht-install", ["install", "claude-plugin", "--yes"]);

			expect(result.status).toBe(1);
			expect(existsSync(join(h.home, ".draht", "claude-marketplace"))).toBe(false);
			expect(existsSync(join(h.home, "escape.txt"))).toBe(false);
			expect(existsSync(join(h.home, "..", "escape.txt"))).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("refuses a second concurrent invocation while a lock is held", async () => {
		const h = makeHarness();
		try {
			const root = join(h.home, ".draht", "install");
			mkdirSync(root, { recursive: true });
			writeFileSync(
				join(root, "lock.json"),
				`${JSON.stringify({
					pid: process.pid,
					hostname: hostname(),
					startedAt: new Date().toISOString(),
					command: "install",
				})}\n`,
			);

			const result = await h.cli("draht-install", ["install", "--yes"]);

			expect(result.status).toBe(3);
			expect(result.stderr).toMatch(/lock|already/i);
		} finally {
			h.dispose();
		}
	});

	it("rolls back and reports honestly when a host call fails", async () => {
		const h = makeHarness();
		try {
			// Replace the claude stub with one that refuses the hard install call.
			const claudePath = join(h.env.PATH?.split(":")[0] as string, "claude");
			writeFileSync(
				claudePath,
				`#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "plugin marketplace list --json") { process.stdout.write("[]"); process.exit(0); }
if (args === "plugin list --json") { process.stdout.write("[]"); process.exit(0); }
if (args.startsWith("plugin install")) { process.stderr.write("host refused"); process.exit(1); }
process.exit(0);
`,
			);
			chmodSync(claudePath, 0o755);

			const result = await h.cli("draht-install", ["install", "claude-plugin", "--yes"]);

			expect(result.status).toBe(3);
			expect(result.stderr).toContain("host refused");
			expect(result.stderr).toMatch(/host registration for claude-plugin may have changed.*reconcile/i);
			expect(existsSync(join(h.home, ".draht", "claude-marketplace"))).toBe(false);
		} finally {
			h.dispose();
		}
	}, 300_000);
});

describe("draht-init from the packed bin", () => {
	it("bootstraps a project and refuses a colliding one", async () => {
		const h = makeHarness();
		try {
			const project = join(h.home, "work", "demo");

			const ok = await h.cli("draht-init", [project, "--yes"]);
			expect(ok.status, ok.stderr).toBe(0);
			expect(existsSync(join(project, ".planning", "PROJECT.md"))).toBe(true);
			expect(ok.stdout).toMatch(/next/i);

			const collision = await h.cli("draht-init", [project, "--yes"]);
			expect(collision.status).toBe(3);
			expect(collision.stderr).toContain(".planning");
			expect(readFileSync(join(project, ".planning", "PROJECT.md"), "utf8").length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	}, 300_000);
});

describe("repository hygiene", () => {
	it("mutates nothing tracked by git", async () => {
		expect((await run("git", ["status", "--porcelain"], REPO_ROOT)).stdout).toBe(gitStatusBefore);
	});

	it("hashes the built cli deterministically across the pack boundary", async () => {
		expect(await sha256File(join(installed, "dist", "cli.js"))).toBe(
			await sha256File(join(PKG_ROOT, "dist", "cli.js")),
		);
	});
});
