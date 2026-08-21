#!/usr/bin/env node
/**
 * draht-claude CLI — installs this package as a Claude Code plugin via a local marketplace.
 *
 * Architecture:
 *   1. Copy plugin files into a local marketplace at ~/.draht/claude-marketplace/
 *   2. Write marketplace.json listing draht-claude as an available plugin
 *   3. Shell out to `claude plugin marketplace add` and `claude plugin install`
 *   4. Claude Code tracks the plugin in its own registries and enables it
 *
 * The install is reversible via `draht-claude uninstall`.
 *
 * Usage:
 *   npx draht-claude install [--path <dir>] [--force]
 *   npx draht-claude uninstall [--path <dir>]
 *   npx draht-claude update [--path <dir>]
 *   npx draht-claude status [--path <dir>]
 *   npx draht-claude --help
 */

import { execSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { extractGraphZip } from "./graph-archive.mjs";
import { GRAPH_IO_LIMITS, validateGraphAttestation, validateGraphChecksums, validateGraphManifest } from "./graph-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = __dirname;

// Marketplace and plugin names
const MARKETPLACE_NAME = "draht";
const PLUGIN_NAME = "draht";

// Default location for the local marketplace we generate
const DEFAULT_MARKETPLACE_DIR = path.join(os.homedir(), ".draht", "claude-marketplace");

// Files in the npm package that must NOT be copied into the plugin tree
const IGNORE = new Set([
	"node_modules",
	"package.json",
	"cli.mjs",
	".npmignore",
	".DS_Store",
	"CHANGELOG.md",
]);

// ─── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = argv.slice(2);
	const command = args[0];
	const flags = {
		path: null, force: false, help: false, agent: null, model: null, list: false, reset: false,
		noGraphEngine: false, graphEngine: false, graphEngineVersion: null, from: null, purgeGraphEngine: false,
	};
	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a === "--path" || a === "-p") {
			flags.path = args[++i];
		} else if (a === "--force" || a === "-f") {
			flags.force = true;
		} else if (a === "--help" || a === "-h") {
			flags.help = true;
		} else if (a === "--agent" || a === "-a") {
			flags.agent = args[++i];
		} else if (a === "--model" || a === "-m") {
			flags.model = args[++i];
		} else if (a === "--list" || a === "-l") {
			flags.list = true;
		} else if (a === "--reset" || a === "-r") {
			flags.reset = true;
		} else if (a === "--graph-engine") {
			flags.graphEngine = true;
		} else if (a === "--no-graph-engine") {
			// Retained for compatibility and for scripted installs that want to be
			// explicit; the fetch is opt-in, so this is a no-op unless combined
			// with --graph-engine, where refusing wins.
			flags.noGraphEngine = true;
		} else if (a === "--graph-engine-version") {
			flags.graphEngineVersion = args[++i];
		} else if (a === "--from") {
			flags.from = args[++i];
		} else if (a === "--purge-graph-engine") {
			flags.purgeGraphEngine = true;
		}
	}
	if (!command || command === "--help" || command === "-h") flags.help = true;
	return { command, flags };
}

function printHelp() {
	console.log(`draht-claude — install and configure the draht Claude Code plugin

Usage:
  npx draht-claude install            Install as a Claude Code plugin
  npx draht-claude install --force    Reinstall even if already present
  npx draht-claude install --path DIR Custom marketplace directory
  npx draht-claude uninstall          Remove the plugin and marketplace
    --purge-graph-engine              Also remove ~/.draht/bin/draht-graph — WARNING: shared with
                                       draht-codex/coding-agent and baked into every repo's
                                       post-commit hook; those stop refreshing MAP.json silently
  npx draht-claude update             Reinstall (same as install --force)
  npx draht-claude status             Show install + enabled state
  npx draht-claude configure          Configure subagent models
    --agent <name> --model <model>    Set model for a specific agent
    --agent <name> --reset            Reset agent to inherit default model
    --reset                           Reset all agents to inherit
    --list                            List current agent model assignments
  npx draht-claude install-graph-engine   Fetch the prebuilt draht-graph binary (alias: graph-engine)
    --graph-engine-version <v>        Pin a version instead of this package's own version
    --from <path>                     Install a locally built binary instead of fetching
    --force                           Re-install even if the same version is already present

Options:
  -p, --path <dir>   Custom local marketplace directory
  -f, --force        Overwrite existing install
  -h, --help         Show this help
  --graph-engine     Also fetch the prebuilt draht-graph binary during install/update
                     (opt-in; downloads an unsigned native binary from GitHub Releases)

What this installs:
  • Local Claude Code marketplace named "${MARKETPLACE_NAME}" at ~/.draht/claude-marketplace/
  • Plugin "${PLUGIN_NAME}" inside that marketplace, registered and enabled
  • 19 slash commands (/new-project, /plan-phase, /execute-phase, /orchestrate, ...)
  • 9 specialist subagents (architect, implementer, reviewer, debugger, ...)
  • 12 bundled skills (gsd-workflow, tdd-workflow, debugging-workflow, ...)
  • Workflow hook scripts (pre-execute, post-task, post-phase, quality-gate)
  • Claude Code lifecycle hooks (SessionStart, UserPromptSubmit)
  • Self-contained draht-tools CLI (JS graph engine built in — works out of the box)

Optional, not installed by default:
  • The prebuilt draht-graph binary (~6x faster map-graph). It is an unsigned
    native binary downloaded from GitHub Releases, so it is opt-in: pass
    --graph-engine, or run 'npx draht-claude install-graph-engine' later.
    Checksums are verified; any failure falls back to the built-in JS engine.

After install, restart Claude Code. Commands appear in the slash command picker.

Docs: https://draht.dev
`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(msg);
}

function err(msg) {
	console.error(`error: ${msg}`);
}

function readPluginManifest() {
	const manifestPath = path.join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
	if (!fs.existsSync(manifestPath)) {
		err(`Plugin manifest not found at ${manifestPath}`);
		err("This usually means the package was installed incorrectly. Reinstall via 'npx draht-claude@latest install'.");
		process.exit(1);
	}
	return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function copyRecursive(src, dest) {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const entry of fs.readdirSync(src)) {
			if (IGNORE.has(entry)) continue;
			copyRecursive(path.join(src, entry), path.join(dest, entry));
		}
	} else {
		fs.copyFileSync(src, dest);
		// Preserve executable bit on bin/ and scripts/
		const parentDir = path.basename(path.dirname(src));
		if ((parentDir === "bin" || parentDir === "scripts") && (stat.mode & 0o111) !== 0) {
			fs.chmodSync(dest, 0o755);
		}
	}
}

function removeRecursive(target) {
	try {
		fs.lstatSync(target);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	fs.rmSync(target, { recursive: true, force: true });
}

function lstatIfExists(target) {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

const MARKETPLACE_LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
function processIdentity(pid) {
	try {
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] || null;
		}
		if (process.platform === "win32") {
			const result = spawnSync("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"], { encoding: "utf8" });
			return result.status === 0 ? result.stdout.trim() || null : null;
		}
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		return result.status === 0 ? result.stdout.trim() || null : null;
	} catch {
		return null;
	}
}

function readMarketplaceLock(lockPath) {
	let descriptor;
	try {
		const before = fs.lstatSync(lockPath);
		if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
		const noFollow = fs.constants.O_NOFOLLOW || 0;
		descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("changed while opening");
		const owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
		const after = fs.lstatSync(lockPath);
		if (after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("changed while reading");
		return { owner, stat: opened };
	} catch (error) {
		throw new Error(`plugin update lock exists but is not safely readable: ${lockPath} (${error.message})`);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function acquireMarketplaceLock(marketplaceDir) {
	const lockPath = `${marketplaceDir}.draht-update-lock`;
	let ownedQuarantine = null;
	for (;;) {
		const token = crypto.randomBytes(8).toString("hex");
		const owner = {
			owner: "draht-plugin-installer",
			pid: process.pid,
			identity: processIdentity(process.pid),
			createdAt: Date.now(),
			token,
		};
		const ownerPath = `${lockPath}.${process.pid}-${token}`;
		fs.writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
		try {
			fs.linkSync(ownerPath, lockPath);
			if (ownedQuarantine) fs.unlinkSync(ownedQuarantine);
			return { lockPath, token };
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		} finally {
			fs.rmSync(ownerPath, { force: true });
		}

		const { owner: existing, stat: observedStat } = readMarketplaceLock(lockPath);
		if (existing?.owner !== "draht-plugin-installer" || !Number.isSafeInteger(existing.pid) || typeof existing.token !== "string" ||
			(existing.identity !== null && typeof existing.identity !== "string") || !Number.isSafeInteger(existing.createdAt)) {
			throw new Error(`plugin update lock is not owned by draht: ${lockPath}`);
		}
		const identity = processIdentity(existing.pid);
		let ownerAlive = identity !== null && existing.identity !== null && identity === existing.identity;
		if (identity === null || existing.identity === null) {
			try {
				process.kill(existing.pid, 0);
				ownerAlive = Date.now() - existing.createdAt < MARKETPLACE_LOCK_MAX_AGE_MS;
			} catch (error) {
				ownerAlive = error.code !== "ESRCH" && Date.now() - existing.createdAt < MARKETPLACE_LOCK_MAX_AGE_MS;
			}
		}
		if (ownerAlive) {
			if (ownedQuarantine) fs.rmSync(ownedQuarantine, { force: true });
			throw new Error(`another plugin update is already in progress (pid ${existing.pid})`);
		}

		const quarantineId = crypto.createHash("sha256").update(existing.token).digest("hex").slice(0, 16);
		const quarantinePath = `${lockPath}.reclaim-${quarantineId}`;
		try {
			fs.linkSync(lockPath, quarantinePath);
		} catch (error) {
			if (error.code === "EEXIST") throw new Error(`another plugin update is already in progress reclaiming a stale lock`);
			if (error.code === "ENOENT") continue;
			throw error;
		}
		try {
			const quarantined = readMarketplaceLock(quarantinePath);
			const current = fs.lstatSync(lockPath);
			if (!sameFile(observedStat, quarantined.stat) || !sameFile(current, quarantined.stat) || quarantined.owner.token !== existing.token) continue;
			fs.unlinkSync(lockPath);
			ownedQuarantine = quarantinePath;
		} finally {
			if (ownedQuarantine !== quarantinePath) fs.rmSync(quarantinePath, { force: true });
		}
	}
}

function releaseMarketplaceLock(lock) {
	const { owner, stat } = readMarketplaceLock(lock.lockPath);
	if (owner.token !== lock.token) throw new Error(`plugin update lock ownership changed: ${lock.lockPath}`);
	const releasePath = `${lock.lockPath}.release-${lock.token}`;
	fs.linkSync(lock.lockPath, releasePath);
	try {
		const linked = fs.lstatSync(releasePath);
		const current = fs.lstatSync(lock.lockPath);
		if (!sameFile(stat, linked) || !sameFile(current, linked)) throw new Error(`plugin update lock ownership changed: ${lock.lockPath}`);
		fs.unlinkSync(lock.lockPath);
	} finally {
		fs.rmSync(releasePath, { force: true });
	}
}

function marketplaceTransactionPaths(marketplaceDir) {
	const parent = path.dirname(marketplaceDir);
	const name = path.basename(marketplaceDir);
	if (!fs.existsSync(parent)) return { temps: [], backups: [] };
	const entries = fs.readdirSync(parent);
	const matching = (kind) => {
		const prefix = `${name}.${kind}-`;
		return entries
			.filter((entry) => entry.startsWith(prefix) && /^\d+-[0-9a-f]{16}$/.test(entry.slice(prefix.length)))
			.map((entry) => path.join(parent, entry));
	};
	return {
		temps: matching("tmp"),
		backups: matching("backup"),
	};
}

function recoverMarketplaceTransaction(marketplaceDir) {
	const { temps, backups } = marketplaceTransactionPaths(marketplaceDir);
	for (const temp of temps) {
		const stat = fs.lstatSync(temp);
		if (stat.isSymbolicLink()) fs.unlinkSync(temp);
		else removeRecursive(temp);
	}
	if (backups.length === 0) return;
	const inspected = backups.map((backup) => ({ backup, stat: fs.lstatSync(backup) }));
	const unsafe = inspected.filter(({ stat }) => stat.isSymbolicLink() || !stat.isDirectory());
	if (unsafe.length > 0) {
		for (const { backup } of unsafe) removeRecursive(backup);
		throw new Error(`refusing unsafe stale marketplace backup (symbolic link or non-directory): ${unsafe[0].backup}`);
	}
	inspected.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	const [{ backup }, ...staleBackups] = inspected;
	removeRecursive(marketplaceDir);
	fs.renameSync(backup, marketplaceDir);
	for (const staleBackup of staleBackups) removeRecursive(staleBackup.backup);
}

function stageMarketplace(marketplaceDir, manifest) {
	fs.mkdirSync(path.dirname(marketplaceDir), { recursive: true });
	const lock = acquireMarketplaceLock(marketplaceDir);
	const suffix = `${process.pid}-${lock.token}`;
	const tempDir = `${marketplaceDir}.tmp-${suffix}`;
	const backupDir = `${marketplaceDir}.backup-${suffix}`;
	let hadPrevious = false;
	let backedUp = false;
	try {
		if (lstatIfExists(marketplaceDir)?.isSymbolicLink()) {
			throw new Error(`refusing to update symlink marketplace: ${marketplaceDir}`);
		}
		recoverMarketplaceTransaction(marketplaceDir);
		const restoredRoot = lstatIfExists(marketplaceDir);
		if (restoredRoot && (restoredRoot.isSymbolicLink() || !restoredRoot.isDirectory())) {
			throw new Error(`refusing to stage through unsafe restored marketplace root: ${marketplaceDir}`);
		}
		hadPrevious = restoredRoot !== null;
		if (hadPrevious) fs.cpSync(marketplaceDir, tempDir, { recursive: true, preserveTimestamps: true });
		else fs.mkdirSync(tempDir, { recursive: true });
		const stagedPluginDir = path.join(tempDir, "plugins", PLUGIN_NAME);
		removeRecursive(stagedPluginDir);
		fs.mkdirSync(stagedPluginDir, { recursive: true });
		copyRecursive(PACKAGE_ROOT, stagedPluginDir);
		removeRecursive(path.join(tempDir, "plugins", "draht-claude"));
		writeMarketplaceManifest(tempDir, manifest);
		if (hadPrevious) {
			fs.renameSync(marketplaceDir, backupDir);
			backedUp = true;
		}
		fs.renameSync(tempDir, marketplaceDir);
		return { marketplaceDir, backupDir, hadPrevious, lock };
	} catch (error) {
		removeRecursive(tempDir);
		if (backedUp && !fs.existsSync(marketplaceDir)) fs.renameSync(backupDir, marketplaceDir);
		releaseMarketplaceLock(lock);
		throw error;
	}
}

function restoreMarketplaceContent(transaction) {
	removeRecursive(transaction.marketplaceDir);
	if (transaction.hadPrevious) fs.renameSync(transaction.backupDir, transaction.marketplaceDir);
}

function rollbackMarketplace(transaction) {
	try {
		restoreMarketplaceContent(transaction);
	} finally {
		releaseMarketplaceLock(transaction.lock);
	}
}

function commitMarketplace(transaction) {
	removeRecursive(transaction.backupDir);
	releaseMarketplaceLock(transaction.lock);
}

function hasClaudeCli() {
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf-8" });
	return which.status === 0 && which.stdout.trim().length > 0;
}

function runClaude(args, { allowFail = false } = {}) {
	log(`  $ claude ${args.join(" ")}`);
	const res = spawnSync("claude", args, { stdio: "inherit" });
	if (res.status !== 0 && !allowFail) {
		err(`claude ${args[0]} ${args[1] || ""} failed with exit code ${res.status}`);
		process.exit(1);
	}
	return res.status === 0;
}

function pluginListEntryMatches(entry, pluginSpec) {
	if (entry === pluginSpec) return true;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	for (const key of ["id", "pluginId", "plugin_id", "spec", "name"]) {
		if (entry[key] === pluginSpec) return true;
	}
	const names = [entry.name, entry.plugin, entry.pluginName, entry.plugin_name];
	const marketplaces = [entry.marketplace, entry.marketplaceName, entry.marketplace_name, entry.source];
	return names.includes(PLUGIN_NAME) && marketplaces.includes(MARKETPLACE_NAME);
}

function claudePluginState(pluginSpec) {
	log("Checking whether the plugin is currently installed...");
	log("  $ claude plugin list --json");
	const result = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`claude plugin list failed with exit code ${result.status}`);
	let entries;
	try {
		entries = JSON.parse(result.stdout);
	} catch {
		throw new Error("claude plugin list returned invalid JSON");
	}
	if (!Array.isArray(entries)) throw new Error("claude plugin list returned an unexpected JSON shape");
	const entry = entries.find((candidate) => pluginListEntryMatches(candidate, pluginSpec));
	if (!entry) return { installed: false, enabled: false };
	const status = typeof entry === "object" && typeof entry.status === "string" ? entry.status.toLowerCase() : null;
	return {
		installed: true,
		enabled: !(typeof entry === "object" && entry.enabled === false) && status !== "disabled",
	};
}

function isClaudeMarketplaceRegistered() {
	log("Checking whether the marketplace is currently registered...");
	log("  $ claude plugin marketplace list --json");
	const result = spawnSync("claude", ["plugin", "marketplace", "list", "--json"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`claude plugin marketplace list failed with exit code ${result.status}`);
	let entries;
	try {
		entries = JSON.parse(result.stdout);
	} catch {
		throw new Error("claude plugin marketplace list returned invalid JSON");
	}
	if (!Array.isArray(entries)) throw new Error("claude plugin marketplace list returned an unexpected JSON shape");
	return entries.some((entry) => entry && typeof entry === "object" && entry.name === MARKETPLACE_NAME);
}

function rollbackClaudePlugin(transaction, previousState, pluginSpec) {
	const failures = [];
	let marketplaceRestored = false;
	try {
		restoreMarketplaceContent(transaction);
		marketplaceRestored = true;
	} catch (error) {
		failures.push(`marketplace restore failed: ${error.message}`);
	}
	try {
		if (!marketplaceRestored) return failures;
		const registrationCommand = previousState.registered
			? ["plugin", "marketplace", "add", transaction.marketplaceDir]
			: ["plugin", "marketplace", "remove", MARKETPLACE_NAME];
		if (!runClaude(registrationCommand, { allowFail: true })) failures.push("could not restore the previous marketplace registration");
		let current;
		try {
			current = claudePluginState(pluginSpec);
		} catch (error) {
			failures.push(`could not inspect plugin state during rollback: ${error.message}`);
			return failures;
		}
		if (current.installed && !runClaude(["plugin", "uninstall", pluginSpec], { allowFail: true })) {
			failures.push("could not remove the failed replacement plugin");
			return failures;
		}
		if (previousState.plugin.installed) {
			if (!runClaude(["plugin", "install", pluginSpec, "--scope", "user"], { allowFail: true })) {
				failures.push("could not reinstall the previously working plugin");
				return failures;
			}
			const stateCommand = previousState.plugin.enabled ? "enable" : "disable";
			let reinstalled = null;
			try {
				reinstalled = claudePluginState(pluginSpec);
			} catch {
				reinstalled = null;
			}
			if (!(reinstalled && reinstalled.installed && reinstalled.enabled === previousState.plugin.enabled)) {
				if (!runClaude(["plugin", stateCommand, pluginSpec], { allowFail: true })) failures.push(`could not restore the previously ${stateCommand}d plugin state`);
			}
		}
		try {
			const restored = claudePluginState(pluginSpec);
			if (restored.installed !== previousState.plugin.installed || (restored.installed && restored.enabled !== previousState.plugin.enabled)) {
				failures.push("plugin state did not match the pre-update state after rollback");
			}
		} catch (error) {
			failures.push(`could not verify plugin state after rollback: ${error.message}`);
		}
		try {
			if (isClaudeMarketplaceRegistered() !== previousState.registered) failures.push("marketplace registration did not match the pre-update state after rollback");
		} catch (error) {
			failures.push(`could not verify marketplace registration after rollback: ${error.message}`);
		}
		return failures;
	} finally {
		try {
			releaseMarketplaceLock(transaction.lock);
		} catch (error) {
			failures.push(`could not release marketplace transaction lock: ${error.message}`);
		}
	}
}

function setModelInFrontmatter(content, model) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return content;
	const lines = match[1].split("\n");
	const modelIdx = lines.findIndex((l) => l.trim().startsWith("model:"));
	if (model === null || model === undefined) {
		if (modelIdx >= 0) lines.splice(modelIdx, 1);
	} else {
		const modelLine = `model: ${model}`;
		if (modelIdx >= 0) {
			lines[modelIdx] = modelLine;
		} else {
			lines.push(modelLine);
		}
	}
	const body = content.slice(match[0].length);
	return `---\n${lines.join("\n")}\n---\n${body}`;
}

function writeMarketplaceManifest(marketplaceDir, pluginManifest) {
	const manifest = {
		$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
		name: MARKETPLACE_NAME,
		description: "Local marketplace for draht-claude. Managed by the draht-claude CLI.",
		owner: {
			name: pluginManifest.author?.name || "draht",
			url: pluginManifest.homepage || "https://draht.dev",
		},
		plugins: [
			{
				name: PLUGIN_NAME,
				description: pluginManifest.description || "Draht GSD, multi-agent, TDD and DDD workflows as a Claude Code plugin",
				source: `./plugins/${PLUGIN_NAME}`,
				category: "workflow",
				homepage: pluginManifest.homepage || "https://draht.dev",
			},
		],
	};
	const manifestDir = path.join(marketplaceDir, ".claude-plugin");
	fs.mkdirSync(manifestDir, { recursive: true });
	fs.writeFileSync(path.join(manifestDir, "marketplace.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ─── graph engine (Go binary fetch) ────────────────────────────────────────
// Installs the prebuilt `draht-graph` binary (go/, Phase 4) into ~/.draht/bin
// so draht-tools.cjs's dispatch shim can find it. This is the ONLY place in
// this CLI that reaches the network for this feature — the command path
// (map-graph, graph-*) must never fetch, since gsd-post-phase and the git
// post-commit hook run it unattended. See .planning/kg-integration/SPEC.md
// § "Go engine cutover".

const GRAPH_BIN_DIR = path.join(os.homedir(), ".draht", "bin");
const GRAPH_RELEASE_REPO = "draht-dev/draht";
// Must equal draht-tools.cjs's GRAPH_SCHEMA_VERSION — kept in sync by hand,
// these are separate npm packages with no shared import.
const GRAPH_SCHEMA_VERSION = 5;
// node-style platform ids matching scripts/build-graph-binaries.sh's
// PLATFORMS table — the only shapes a release ever ships.
const GRAPH_SHIPPED_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]);

function graphBinName() {
	return process.platform === "win32" ? "draht-graph.exe" : "draht-graph";
}

function graphPlatform() {
	const osName = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
	const archName = { x64: "x64", arm64: "arm64" }[process.arch];
	if (!osName || !archName) return null;
	const p = `${osName}-${archName}`;
	return GRAPH_SHIPPED_PLATFORMS.has(p) ? p : null;
}

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

// entry.archive/entry.binary come from the fetched manifest.json (release
// metadata, not this package's own code) and flow unmodified into a
// path.join (path traversal), a download URL, and — in extractZip's
// PowerShell fallback — a single-quoted -Command string, where one
// apostrophe breaks out into arbitrary command execution. Reachable only by
// whoever controls the release manifest or an HTTPS MITM, but cheap to
// close: reject anything that isn't a plain filename.
const GRAPH_MANIFEST_NAME_RE = /^[A-Za-z0-9._-]+$/;
function graphManifestNameOk(name) {
	return typeof name === "string" && name.length > 0 && GRAPH_MANIFEST_NAME_RE.test(name);
}

// Minimal POSIX ustar reader — Node ships no built-in tar support and this
// package may add no new dependency. Only handles what
// scripts/build-graph-binaries.sh actually produces (regular files +
// directories, short names, no pax/long-name extensions). Rejects
// path-traversal entries (zip-slip).
function extractTarGz(archivePath, destDir, maxDecompressedBytes) {
	let tar;
	try {
		tar = zlib.gunzipSync(fs.readFileSync(archivePath), { maxOutputLength: maxDecompressedBytes });
	} catch (error) {
		if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new Error(`graph archive decompressed data exceeds ${maxDecompressedBytes} bytes`);
		throw error;
	}
	const readStr = (start, len) => {
		const slice = tar.subarray(start, start + len);
		const nul = slice.indexOf(0);
		return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString("utf-8");
	};
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break; // end-of-archive marker
		const name = readStr(offset, 100);
		const sizeOctal = readStr(offset + 124, 12).trim();
		const typeflag = String.fromCharCode(header[156] || 0);
		const size = sizeOctal ? Number.parseInt(sizeOctal, 8) || 0 : 0;
		offset += 512;
		const dataStart = offset;
		const outPath = path.join(destDir, name);
		if (!outPath.startsWith(destDir + path.sep) && outPath !== destDir) {
			throw new Error(`unsafe tar entry path: ${name}`);
		}
		if (typeflag === "5") {
			fs.mkdirSync(outPath, { recursive: true });
		} else if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, tar.subarray(dataStart, dataStart + size));
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
}

function extractZip(archivePath, destDir, entry) {
	extractGraphZip(archivePath, destDir, {
		binary: entry.binary,
		binaryBytes: entry.binaryBytes,
		maxUncompressedBytes: Math.min(GRAPH_IO_LIMITS.decompressedBytes, entry.binaryBytes + 2 * 1024 * 1024),
		maxCompressedBytes: entry.archiveBytes,
	});
}

async function fetchBuffer(url, timeoutMs, { limit, label, aggregate }) {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
	const contentLength = Number(res.headers?.get?.("content-length"));
	if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(`${label} Content-Length exceeds ${limit} byte limit`);
	if (!res.body?.getReader) throw new Error(`${label} response body is not a readable stream`);
	const reader = res.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new Error(`${label} exceeds ${limit} byte limit`);
			if (aggregate.bytes + bytes > GRAPH_IO_LIMITS.aggregateDownloadBytes) throw new Error("graph release downloads exceed aggregate byte limit");
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	}
	aggregate.bytes += bytes;
	return Buffer.concat(chunks, bytes);
}

async function fetchJson(url, timeoutMs, aggregate) {
	const bytes = await fetchBuffer(url, timeoutMs, { limit: GRAPH_IO_LIMITS.manifestBytes, label: "graph manifest", aggregate });
	try { return JSON.parse(bytes.toString("utf8")); }
	catch (error) { throw new Error(`graph manifest is not valid JSON: ${error.message}`, { cause: error }); }
}

function runGh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw new Error(`gh ${args[0]} unavailable: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${(result.stderr || "").trim()}`);
	return result.stdout;
}

function resolveGraphReleaseCommit(tag) {
	let object = JSON.parse(runGh(["api", `repos/${GRAPH_RELEASE_REPO}/git/ref/tags/${tag}`])).object;
	for (let depth = 0; depth < 8 && object?.type === "tag"; depth++) {
		object = JSON.parse(runGh(["api", `repos/${GRAPH_RELEASE_REPO}/git/tags/${object.sha}`])).object;
	}
	if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error(`release tag ${tag} does not resolve to an exact commit`);
	return object.sha;
}

function verifyGraphAttestation(archivePath, entry, commit, tag) {
	const output = runGh(["attestation", "verify", archivePath, "--repo", GRAPH_RELEASE_REPO, "--predicate-type", "https://slsa.dev/provenance/v1", "--deny-self-hosted-runners", "--format", "json"]);
	validateGraphAttestation(output, { archive: entry.archive, digest: entry.archiveSha256, repo: GRAPH_RELEASE_REPO, commit, tag });
}

// Atomically installs `srcPath` (an already-verified local binary) as the
// stable ~/.draht/bin/draht-graph[.exe] entry point — a REAL COPY, not a
// symlink (graph-hook bakes os.Executable()'s fully-resolved path into
// .git/hooks/post-commit; a symlink target would break on the next
// upgrade+prune) — and writes the provenance stamp draht-tools.cjs's
// resolver checks. Used by both the network fetch path and `--from <path>`.
function installGraphBinary(srcPath, { version, binarySha256, binaryBytes }) {
	fs.mkdirSync(GRAPH_BIN_DIR, { recursive: true });
	const target = path.join(GRAPH_BIN_DIR, graphBinName());
	const stampPath = path.join(GRAPH_BIN_DIR, ".draht-graph.json");
	const nonce = `${process.pid}.${Date.now()}`;
	const binaryTmp = `${target}.${nonce}.tmp`;
	const stampTmp = `${stampPath}.${nonce}.tmp`;
	const stamp = `${JSON.stringify(
		{
			name: "draht-graph",
			version,
			schemaVersion: GRAPH_SCHEMA_VERSION,
			sha256: binarySha256,
			size: binaryBytes,
			installedAt: new Date().toISOString(),
		},
		null,
		2,
	)}\n`;
	try {
		fs.copyFileSync(srcPath, binaryTmp);
		fs.chmodSync(binaryTmp, 0o755);
		fs.writeFileSync(stampTmp, stamp, { mode: 0o600 });
		// Each file replacement is atomic. Publishing the stamp first means a crash
		// between renames leaves a digest mismatch, which all resolvers reject.
		fs.renameSync(stampTmp, stampPath);
		fs.renameSync(binaryTmp, target);
	} finally {
		fs.rmSync(binaryTmp, { force: true });
		fs.rmSync(stampTmp, { force: true });
	}
	if (process.platform === "darwin") {
		// Unsigned/unnotarized artifacts get Gatekeeper-quarantined on
		// download; a quarantined binary silently fails to exec inside a hook.
		spawnSync("xattr", ["-d", "com.apple.quarantine", target], { stdio: "ignore" });
	}
	return target;
}

function installedGraphBinaryMatches(target, stampPath, version) {
	try {
		const stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
		if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return false;
		if (stamp.name !== "draht-graph" || stamp.version !== version || stamp.schemaVersion !== GRAPH_SCHEMA_VERSION) return false;
		if (!Number.isSafeInteger(stamp.size) || stamp.size < 0 || !/^[0-9a-f]{64}$/.test(stamp.sha256)) return false;
		const binary = fs.readFileSync(target);
		return binary.length === stamp.size && sha256(binary) === stamp.sha256;
	} catch {
		return false;
	}
}

// Never throws — every failure degrades to "draht will use the built-in JS
// engine", per SPEC.md's non-negotiable install policy. Called as the LAST
// step of cmdInstall (after the plugin itself is installed and enabled), so
// a graph-engine fetch failure can never fail `npx draht-claude install`.
async function ensureGraphEngine(flags) {
	if (flags.noGraphEngine || process.env.DRAHT_SKIP_GRAPH_ENGINE) return;
	try {
		if (flags.from) {
			const buf = fs.readFileSync(flags.from);
			const target = installGraphBinary(flags.from, {
				version: flags.graphEngineVersion || "local",
				binarySha256: sha256(buf),
				binaryBytes: buf.length,
			});
			log(`✓ graph engine installed from ${flags.from} → ${target}`);
			return;
		}

		const target = path.join(GRAPH_BIN_DIR, graphBinName());
		const stampPath = path.join(GRAPH_BIN_DIR, ".draht-graph.json");
		let pkgVersion = "0.0.0";
		try {
			pkgVersion = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")).version;
		} catch { /* fall back to 0.0.0 — forces a fetch attempt rather than a false "up to date" */ }
		const version = flags.graphEngineVersion || process.env.DRAHT_GRAPH_ENGINE_VERSION || pkgVersion;

		if (fs.existsSync(target) && !flags.force && installedGraphBinaryMatches(target, stampPath, version)) {
			log(`✓ graph engine v${version} already installed`);
			return;
		}

		const platform = graphPlatform();
		if (!platform) {
			log(`⚠ no prebuilt graph engine binary for ${process.platform}/${process.arch} — draht will use the built-in JS engine.`);
			return;
		}

		const tag = version.startsWith("v") ? version : `v${version}`;
		const base = `https://github.com/${GRAPH_RELEASE_REPO}/releases/download/${tag}`;
		const releaseCommit = resolveGraphReleaseCommit(tag);
		const aggregate = { bytes: 0 };
		const manifest = await fetchJson(`${base}/manifest.json`, 15_000, aggregate);
		const entry = validateGraphManifest(manifest, { version, tag, platform, commit: releaseCommit });
		if (!graphManifestNameOk(entry.archive) || !graphManifestNameOk(entry.binary)) {
			log(`⚠ release ${tag}'s manifest.json has an invalid archive/binary name for ${platform} — refusing to use it. draht will use the built-in JS engine.`);
			return;
		}
		const checksums = (await fetchBuffer(`${base}/SHA256SUMS`, 15_000, { limit: GRAPH_IO_LIMITS.checksumBytes, label: "graph checksum file", aggregate })).toString("utf8");
		validateGraphChecksums(checksums, entry, platform);

		const archiveBuf = await fetchBuffer(`${base}/${entry.archive}`, 120_000, { limit: entry.archiveBytes, label: "graph archive", aggregate });
		if (sha256(archiveBuf) !== entry.archiveSha256 || archiveBuf.length !== entry.archiveBytes) {
			log(`⚠ graph engine download failed (checksum mismatch on ${entry.archive}) — draht will use the built-in JS engine.`);
			return;
		}

		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-graph-"));
		try {
			const archivePath = path.join(workDir, entry.archive);
			fs.writeFileSync(archivePath, archiveBuf);
			verifyGraphAttestation(archivePath, entry, releaseCommit, tag);
			const extractDir = path.join(workDir, "extracted");
			if (entry.archive.endsWith(".zip")) extractZip(archivePath, extractDir, entry);
			else extractTarGz(archivePath, extractDir, Math.min(GRAPH_IO_LIMITS.decompressedBytes, entry.binaryBytes + 2 * 1024 * 1024));

			// Both archive formats wrap a draht-graph/ directory — see
			// scripts/build-graph-binaries.sh.
			const binPath = path.join(extractDir, "draht-graph", entry.binary);
			const binarySize = fs.statSync(binPath).size;
			if (binarySize > entry.binaryBytes || binarySize > GRAPH_IO_LIMITS.binaryBytes) throw new Error(`extracted graph binary exceeds ${entry.binaryBytes} byte limit`);
			const binBuf = fs.readFileSync(binPath);
			if (sha256(binBuf) !== entry.binarySha256 || binBuf.length !== entry.binaryBytes) {
				log(`⚠ graph engine download failed (checksum mismatch on extracted ${entry.binary}) — draht will use the built-in JS engine.`);
				return;
			}

			installGraphBinary(binPath, { version, binarySha256: entry.binarySha256, binaryBytes: entry.binaryBytes });
			log(`✓ graph engine v${version} → ${target} (${(entry.binaryBytes / 1e6).toFixed(1)} MB) — map-graph is now much faster`);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	} catch (error) {
		log(`⚠ graph engine download failed (${error.message}) — draht will use the built-in JS engine.`);
		log("  Retry any time:  npx draht-claude install-graph-engine");
	}
}

function removeGraphEngine() {
	if (!fs.existsSync(GRAPH_BIN_DIR)) return;
	removeRecursive(path.join(GRAPH_BIN_DIR, graphBinName()));
	removeRecursive(path.join(GRAPH_BIN_DIR, ".draht-graph.json"));
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdInstall(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const manifest = readPluginManifest();

	log("draht-claude installer");
	log(`  plugin:      ${manifest.name} v${manifest.version}`);
	log(`  source:      ${PACKAGE_ROOT}`);
	log(`  marketplace: ${marketplaceDir}`);
	log(`  plugin dir:  ${pluginDir}`);
	log("");

	// Check prerequisites
	if (!hasClaudeCli()) {
		err("claude CLI not found in PATH");
		err("Install Claude Code first: https://claude.com/claude-code");
		process.exit(1);
	}

	// Bail early if already installed and not forcing
	if (fs.existsSync(pluginDir) && !flags.force) {
		err(`plugin already installed at ${pluginDir}`);
		err("use --force to reinstall, or 'draht-claude update' to refresh");
		process.exit(1);
	}

	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

	// Build the complete marketplace beside the live tree, then switch it with
	// rename operations. A surviving backup means an interrupted transaction and
	// is restored before staging the next update.
	log("Staging plugin files and marketplace.json...");
	const marketplaceTransaction = stageMarketplace(marketplaceDir, manifest);

	// Capture registration state while holding the marketplace transaction lock
	// and before any destructive CLI command. JSON avoids display-format parsing.
	let previousState;
	try {
		previousState = {
			registered: isClaudeMarketplaceRegistered(),
			plugin: claudePluginState(pluginSpec),
		};
	} catch (error) {
		try {
			rollbackMarketplace(marketplaceTransaction);
		} catch (rollbackError) {
			err(`rollback failed: marketplace restore failed: ${rollbackError.message}`);
		}
		err(`could not determine existing marketplace and plugin state: ${error.message}`);
		process.exit(1);
	}

	try {
		log("Validating manifest...");
		if (!runClaude(["plugin", "validate", pluginDir], { allowFail: true })) throw new Error("plugin validation failed");

		log("Registering marketplace with Claude Code...");
		const registrationCommand = previousState.registered
			? ["plugin", "marketplace", "update", MARKETPLACE_NAME]
			: ["plugin", "marketplace", "add", marketplaceDir];
		if (!runClaude(registrationCommand, { allowFail: true })) throw new Error("marketplace registration failed");

		if (previousState.plugin.installed) {
			log("Removing previously installed plugin so Claude Code re-copies fresh files...");
			if (!runClaude(["plugin", "uninstall", pluginSpec], { allowFail: true })) throw new Error("previous plugin removal failed");
		}
		log("Installing plugin...");
		if (!runClaude(["plugin", "install", pluginSpec, "--scope", "user"], { allowFail: true })) throw new Error("replacement install failed");

		const shouldEnable = previousState.plugin.installed ? previousState.plugin.enabled : true;
		const stateCommand = shouldEnable ? "enable" : "disable";
		const stateAfterInstall = claudePluginState(pluginSpec);
		if (stateAfterInstall.installed && stateAfterInstall.enabled === shouldEnable) {
			log(`Plugin already ${stateCommand}d after install; skipping ${stateCommand}.`);
		} else if (!runClaude(["plugin", stateCommand, pluginSpec], { allowFail: true })) {
			throw new Error(`plugin ${stateCommand} failed`);
		}
		const installedState = claudePluginState(pluginSpec);
		if (!installedState.installed || installedState.enabled !== shouldEnable) throw new Error("post-install plugin state verification failed");
	} catch (error) {
		const rollbackFailures = rollbackClaudePlugin(marketplaceTransaction, previousState, pluginSpec);
		err(error.message);
		err(marketplaceTransaction.hadPrevious ? "rollback: restored the previous marketplace content" : "rollback: removed the failed marketplace content");
		for (const failure of rollbackFailures) err(`rollback failed: ${failure}`);
		process.exit(1);
	}

	commitMarketplace(marketplaceTransaction);

	// The graph engine is a separate, OPT-IN download. It is deliberately not
	// fetched by default: the artifact is an unsigned native binary pulled from
	// a GitHub release, and silently downloading and exec'ing one as a side
	// effect of installing a plugin is not a decision this installer should make
	// for the user. `--graph-engine` (or `install-graph-engine` later) asks for
	// it explicitly. Until binaries are actually published, a default fetch
	// would also just be a doomed request on every install.
	// Runs LAST so a download failure can never fail the plugin install
	// (ensureGraphEngine never throws).
	if (flags.graphEngine) {
		await ensureGraphEngine(flags);
	}

	log("");
	log(`✓ installed ${PLUGIN_NAME}@${MARKETPLACE_NAME} v${manifest.version}`);
	log("");
	log("Next steps:");
	log("  1. Restart Claude Code so it picks up the plugin");
	log("  2. Check that commands appear: run `claude plugin list`");
	log("  3. Try /new-project or /orchestrate inside Claude Code");
	log("");
	log("Docs: https://draht.dev");
}

function cmdUninstall(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

	// ~/.draht/bin is a sibling of the marketplace dir, shared across
	// draht-claude/draht-codex/coding-agent, AND its resolved absolute path is
	// baked into every repo's .git/hooks/post-commit (go/internal/hook). Removing
	// it here would silently break graph-engine use in every OTHER package and
	// silently no-op every repo's post-commit hook — so it is opt-in only.
	if (flags.purgeGraphEngine) {
		removeGraphEngine();
		log("Removed ~/.draht/bin/draht-graph (--purge-graph-engine) — draht-codex/coding-agent");
		log("and any repo's post-commit hook that used it will now fall back to the JS engine.");
	} else if (fs.existsSync(GRAPH_BIN_DIR)) {
		log("Leaving ~/.draht/bin/draht-graph in place (shared with draht-codex/coding-agent).");
		log("Remove it too with: npx draht-claude uninstall --purge-graph-engine");
	}

	log("draht-claude uninstaller");
	log(`  marketplace: ${marketplaceDir}`);
	log(`  plugin:      ${pluginSpec}`);
	log("");

	// Try to uninstall via claude CLI first (removes from settings.json + registries)
	if (hasClaudeCli()) {
		log("Disabling plugin in Claude Code...");
		runClaude(["plugin", "disable", pluginSpec], { allowFail: true });
		log("Uninstalling plugin...");
		runClaude(["plugin", "uninstall", pluginSpec], { allowFail: true });
		log("Removing marketplace...");
		runClaude(["plugin", "marketplace", "remove", MARKETPLACE_NAME], { allowFail: true });
	} else {
		log("(claude CLI not found — skipping registry cleanup)");
	}

	// Remove local marketplace files
	if (fs.existsSync(marketplaceDir)) {
		log(`Removing ${marketplaceDir}...`);
		removeRecursive(marketplaceDir);
	}

	log("");
	log("✓ uninstalled");
}

async function cmdUpdate(flags) {
	await cmdInstall({ ...flags, force: true });
}

function cmdStatus(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const pluginManifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");

	log(`marketplace dir: ${marketplaceDir}`);

	if (!fs.existsSync(pluginManifestPath)) {
		log("status:          not installed");
		return;
	}
	try {
		const manifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf-8"));
		log("status:          files present");
		log(`plugin:          ${manifest.name} v${manifest.version}`);
		log(`description:     ${manifest.description || "(none)"}`);
	} catch (e) {
		log(`status:          files present (manifest unreadable: ${e.message})`);
	}

	// Show claude's view if available
	if (hasClaudeCli()) {
		log("");
		log("Claude Code plugin list:");
		try {
			const out = execSync("claude plugin list", { encoding: "utf-8" });
			process.stdout.write(out);
		} catch {
			log("  (failed to run `claude plugin list`)");
		}
	}
}

function cmdConfigure(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const agentsDir = path.join(pluginDir, "agents");

	if (!fs.existsSync(pluginDir)) {
		err(`plugin not installed at ${pluginDir}`);
		err("run 'draht-claude install' first");
		process.exit(1);
	}

	if (flags.list) {
		if (!fs.existsSync(agentsDir)) {
			log("no agents directory found");
			return;
		}
		const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
		if (files.length === 0) {
			log("no agents found");
			return;
		}
		log("Agent models:");
		for (const file of files.sort()) {
			const content = fs.readFileSync(path.join(agentsDir, file), "utf-8");
			const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
			let model = "inherit (default)";
			if (match) {
				const modelLine = match[1].split("\n").find((l) => l.trim().startsWith("model:"));
				if (modelLine) {
					model = modelLine.split(":").slice(1).join(":").trim();
				}
			}
			log(`  ${file.replace(".md", "")}: ${model}`);
		}
		return;
	}

	if (flags.reset) {
		if (flags.agent) {
			const agentFile = path.join(agentsDir, `${flags.agent}.md`);
			if (!fs.existsSync(agentFile)) {
				err(`agent not found: ${flags.agent}`);
				process.exit(1);
			}
			const content = fs.readFileSync(agentFile, "utf-8");
			const updated = setModelInFrontmatter(content, null);
			fs.writeFileSync(agentFile, updated);
			log(`✓ reset model for ${flags.agent} to inherit`);
		} else {
			if (!fs.existsSync(agentsDir)) return;
			const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
			for (const file of files) {
				const agentFile = path.join(agentsDir, file);
				const content = fs.readFileSync(agentFile, "utf-8");
				const updated = setModelInFrontmatter(content, null);
				fs.writeFileSync(agentFile, updated);
			}
			log("✓ reset model for all agents to inherit");
		}
		return;
	}

	if (!flags.agent || !flags.model) {
		err("configure requires --agent <name> and --model <model>");
		err("run 'draht-claude configure --help' for usage");
		process.exit(1);
	}

	const agentFile = path.join(agentsDir, `${flags.agent}.md`);
	if (!fs.existsSync(agentFile)) {
		err(`agent not found: ${flags.agent}`);
		const available = fs.existsSync(agentsDir)
			? fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", "")).join(", ")
			: "(none)";
		err(`available agents: ${available}`);
		process.exit(1);
	}

	const content = fs.readFileSync(agentFile, "utf-8");
	const updated = setModelInFrontmatter(content, flags.model);
	fs.writeFileSync(agentFile, updated);
	log(`✓ set model for ${flags.agent} to ${flags.model}`);
}

// ─── main ───────────────────────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv);

if (flags.help) {
	printHelp();
	process.exit(0);
}

(async () => {
	switch (command) {
		case "install":
			await cmdInstall(flags);
			break;
		case "uninstall":
		case "remove":
			cmdUninstall(flags);
			break;
		case "update":
		case "upgrade":
			await cmdUpdate(flags);
			break;
		case "status":
			cmdStatus(flags);
			break;
		case "configure":
			cmdConfigure(flags);
			break;
		case "install-graph-engine":
		case "graph-engine":
			await ensureGraphEngine(flags);
			break;
		default:
			err(`unknown command: ${command}`);
			err("run 'draht-claude --help' for usage");
			process.exit(1);
	}
})();
