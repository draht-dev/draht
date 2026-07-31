#!/usr/bin/env node
/**
 * draht-codex CLI: installs this package as a Codex plugin via a local marketplace.
 *
 * Architecture:
 *   1. Copy plugin files into ~/.draht/codex-marketplace/plugins/draht/
 *   2. Write .agents/plugins/marketplace.json for Codex
 *   3. Shell out to `codex plugin marketplace add` and `codex plugin add`
 *   4. Codex tracks the plugin in its own cache and config
 *
 * Usage:
 *   npx draht-codex install [--path <dir>] [--force]
 *   npx draht-codex uninstall [--path <dir>]
 *   npx draht-codex update [--path <dir>]
 *   npx draht-codex status [--path <dir>]
 *   npx draht-codex draht-tools <subcommand> [...args]
 *   npx draht-codex --help
 */

import { execSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = __dirname;

const MARKETPLACE_NAME = "draht";
const PLUGIN_NAME = "draht";
const DEFAULT_MARKETPLACE_DIR = path.join(os.homedir(), ".draht", "codex-marketplace");

const IGNORE = new Set([
	"node_modules",
	"package.json",
	"cli.mjs",
	".npmignore",
	".DS_Store",
	"CHANGELOG.md",
]);

function parseArgs(argv) {
	const args = argv.slice(2);
	const command = args[0];
	const flags = {
		path: null, force: false, help: false, agent: null, model: null, list: false, reset: false,
		noGraphEngine: false, graphEngine: false, graphEngineVersion: null, from: null, purgeGraphEngine: false,
	};
	const passthrough = [];

	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (command === "draht-tools") {
			passthrough.push(a);
		} else if (a === "--path" || a === "-p") {
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
	return { command, flags, passthrough };
}

function printHelp() {
	console.log(`draht-codex - install and configure the draht Codex plugin

Usage:
  npx draht-codex install            Install as a Codex plugin
  npx draht-codex install --force    Reinstall even if already present
  npx draht-codex install --path DIR Custom marketplace directory
  npx draht-codex uninstall          Remove the plugin and marketplace
    --purge-graph-engine              Also remove ~/.draht/bin/draht-graph — WARNING: shared with
                                       draht-claude/coding-agent and baked into every repo's
                                       post-commit hook; those stop refreshing MAP.json silently
  npx draht-codex update             Reinstall (same as install --force)
  npx draht-codex status             Show install state
  npx draht-codex configure          Configure bundled reference agent models
    --agent <name> --model <model>   Set model metadata for a specific agent
    --agent <name> --reset           Reset agent model metadata
    --reset                          Reset all agent model metadata
    --list                           List current agent model metadata
  npx draht-codex draht-tools ...    Run the bundled draht-tools CLI
  npx draht-codex install-graph-engine   Fetch the prebuilt draht-graph binary (alias: graph-engine)
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
  - Local Codex marketplace named "${MARKETPLACE_NAME}" at ~/.draht/codex-marketplace/
  - Plugin "${PLUGIN_NAME}" inside that marketplace
  - Draht command prompt wrappers, reference prompt templates, specialist agent prompts, support skills, hooks, and scripts
  - Self-contained draht-tools CLI (JS graph engine built in — works out of the box)

Optional, not installed by default:
  - The prebuilt draht-graph binary (~6x faster map-graph). It is an unsigned
    native binary downloaded from GitHub Releases, so it is opt-in: pass
    --graph-engine, or run 'npx draht-codex install-graph-engine' later.
    Checksums are verified; any failure falls back to the built-in JS engine.

After install, restart Codex. Use $draht:<command> or /skills and select the command wrapper.
Prompt templates remain installed under commands/; Codex CLI currently does not expose plugin commands as slash commands.

Docs: https://draht.dev
`);
}

function log(msg) {
	console.log(msg);
}

function err(msg) {
	console.error(`error: ${msg}`);
}

function readPluginManifest() {
	const manifestPath = path.join(PACKAGE_ROOT, ".codex-plugin", "plugin.json");
	if (!fs.existsSync(manifestPath)) {
		err(`Plugin manifest not found at ${manifestPath}`);
		err("Reinstall via 'npx draht-codex@latest install'.");
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
		const parentDir = path.basename(path.dirname(src));
		if ((parentDir === "bin" || parentDir === "scripts") && (stat.mode & 0o111) !== 0) {
			fs.chmodSync(dest, 0o755);
		}
	}
}

function removeRecursive(target) {
	if (!fs.existsSync(target)) return;
	fs.rmSync(target, { recursive: true, force: true });
}

function hasCodexCli() {
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf-8" });
	return which.status === 0 && which.stdout.trim().length > 0;
}

function runCodex(args, { allowFail = false } = {}) {
	log(`  $ codex ${args.join(" ")}`);
	const res = spawnSync("codex", args, { stdio: "inherit" });
	if (res.status !== 0 && !allowFail) {
		err(`codex ${args[0]} ${args[1] || ""} failed with exit code ${res.status}`);
		process.exit(1);
	}
	return res.status === 0;
}

function setModelInFrontmatter(content, model) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return content;
	const lines = match[1].split("\n");
	const modelIdx = lines.findIndex((line) => line.trim().startsWith("model:"));
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
		name: MARKETPLACE_NAME,
		interface: {
			displayName: "Draht",
		},
		plugins: [
			{
				name: PLUGIN_NAME,
				source: {
					source: "local",
					path: `./plugins/${PLUGIN_NAME}`,
				},
				policy: {
					installation: "AVAILABLE",
					authentication: "ON_INSTALL",
				},
				category: pluginManifest.interface?.category || "Coding",
			},
		],
	};
	const manifestDir = path.join(marketplaceDir, ".agents", "plugins");
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
function extractTarGz(archivePath, destDir) {
	const tar = zlib.gunzipSync(fs.readFileSync(archivePath));
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

// Windows-only artifact format (in practice this only ever runs on Windows,
// since graphPlatform() only selects the .zip entry for windows-x64). No
// zip-reading stdlib in Node, so this shells out to a system archive tool
// rather than hand-rolling DEFLATE: `unzip` (WSL/Cygwin/msys), then
// `tar.exe` (bsdtar, built into Windows 10 1803+, reads zip), then
// PowerShell's Expand-Archive. All failing surfaces as a normal
// ensureGraphEngine() catch.
function extractZip(archivePath, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	let res = spawnSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "ignore" });
	if (res.status === 0) return;
	res = spawnSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "ignore" });
	if (res.status === 0) return;
	res = spawnSync(
		"powershell",
		["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`],
		{ stdio: "ignore" },
	);
	if (res.status === 0) return;
	throw new Error("no working zip extractor found (tried unzip, tar, and PowerShell Expand-Archive)");
}

async function fetchJson(url, timeoutMs) {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
	return res.json();
}

async function fetchBuffer(url, timeoutMs) {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
	return Buffer.from(await res.arrayBuffer());
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
	const tmp = `${target}.${process.pid}.tmp`;
	fs.copyFileSync(srcPath, tmp);
	fs.chmodSync(tmp, 0o755);
	fs.renameSync(tmp, target);
	if (process.platform === "darwin") {
		// Unsigned/unnotarized artifacts get Gatekeeper-quarantined on
		// download; a quarantined binary silently fails to exec inside a hook.
		spawnSync("xattr", ["-d", "com.apple.quarantine", target], { stdio: "ignore" });
	}
	fs.writeFileSync(
		path.join(GRAPH_BIN_DIR, ".draht-graph.json"),
		`${JSON.stringify(
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
		)}\n`,
	);
	return target;
}

// Never throws — every failure degrades to "draht will use the built-in JS
// engine", per SPEC.md's non-negotiable install policy. Called as the LAST
// step of cmdInstall (after the plugin itself is installed), so a
// graph-engine fetch failure can never fail `npx draht-codex install`.
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
			log(`installed graph engine from ${flags.from} -> ${target}`);
			return;
		}

		const target = path.join(GRAPH_BIN_DIR, graphBinName());
		const stampPath = path.join(GRAPH_BIN_DIR, ".draht-graph.json");
		let pkgVersion = "0.0.0";
		try {
			pkgVersion = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")).version;
		} catch { /* fall back to 0.0.0 — forces a fetch attempt rather than a false "up to date" */ }
		const version = flags.graphEngineVersion || process.env.DRAHT_GRAPH_ENGINE_VERSION || pkgVersion;

		if (fs.existsSync(target) && !flags.force) {
			try {
				const stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
				if (stamp.version === version) {
					log(`graph engine v${version} already installed`);
					return;
				}
			} catch { /* no/unreadable stamp — fall through and (re)fetch */ }
		}

		const platform = graphPlatform();
		if (!platform) {
			log(`no prebuilt graph engine binary for ${process.platform}/${process.arch} — draht will use the built-in JS engine.`);
			return;
		}

		const tag = version.startsWith("v") ? version : `v${version}`;
		const base = `https://github.com/${GRAPH_RELEASE_REPO}/releases/download/${tag}`;
		const manifest = await fetchJson(`${base}/manifest.json`, 15_000);
		const entry = (manifest.artifacts || []).find((a) => a.platform === platform);
		if (!entry) {
			log(`release ${tag} has no graph engine artifact for ${platform} — draht will use the built-in JS engine.`);
			return;
		}
		if (!graphManifestNameOk(entry.archive) || !graphManifestNameOk(entry.binary)) {
			log(`release ${tag}'s manifest.json has an invalid archive/binary name for ${platform} — refusing to use it. draht will use the built-in JS engine.`);
			return;
		}

		const archiveBuf = await fetchBuffer(`${base}/${entry.archive}`, 120_000);
		if (sha256(archiveBuf) !== entry.archiveSha256 || archiveBuf.length !== entry.archiveBytes) {
			log(`graph engine download failed (checksum mismatch on ${entry.archive}) — draht will use the built-in JS engine.`);
			return;
		}

		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-graph-"));
		try {
			const archivePath = path.join(workDir, entry.archive);
			fs.writeFileSync(archivePath, archiveBuf);
			const extractDir = path.join(workDir, "extracted");
			if (entry.archive.endsWith(".zip")) extractZip(archivePath, extractDir);
			else extractTarGz(archivePath, extractDir);

			// Both archive formats wrap a draht-graph/ directory — see
			// scripts/build-graph-binaries.sh.
			const binPath = path.join(extractDir, "draht-graph", entry.binary);
			const binBuf = fs.readFileSync(binPath);
			if (sha256(binBuf) !== entry.binarySha256 || binBuf.length !== entry.binaryBytes) {
				log(`graph engine download failed (checksum mismatch on extracted ${entry.binary}) — draht will use the built-in JS engine.`);
				return;
			}

			installGraphBinary(binPath, { version, binarySha256: entry.binarySha256, binaryBytes: entry.binaryBytes });
			log(`graph engine v${version} -> ${target} (${(entry.binaryBytes / 1e6).toFixed(1)} MB) — map-graph is now much faster`);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	} catch (error) {
		log(`graph engine download failed (${error.message}) — draht will use the built-in JS engine.`);
		log("  Retry any time:  npx draht-codex install-graph-engine");
	}
}

function removeGraphEngine() {
	if (!fs.existsSync(GRAPH_BIN_DIR)) return;
	removeRecursive(path.join(GRAPH_BIN_DIR, graphBinName()));
	removeRecursive(path.join(GRAPH_BIN_DIR, ".draht-graph.json"));
}

async function cmdInstall(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
	const manifest = readPluginManifest();

	log("draht-codex installer");
	log(`  plugin:      ${manifest.name} v${manifest.version}`);
	log(`  source:      ${PACKAGE_ROOT}`);
	log(`  marketplace: ${marketplaceDir}`);
	log(`  plugin dir:  ${pluginDir}`);
	log("");

	if (!hasCodexCli()) {
		err("codex CLI not found in PATH");
		err("Install Codex first: https://developers.openai.com/codex");
		process.exit(1);
	}

	if (fs.existsSync(pluginDir) && !flags.force) {
		err(`plugin already installed at ${pluginDir}`);
		err("use --force to reinstall, or 'draht-codex update' to refresh");
		process.exit(1);
	}

	log("Copying plugin files...");
	if (flags.force && fs.existsSync(pluginDir)) {
		removeRecursive(pluginDir);
	}
	fs.mkdirSync(pluginDir, { recursive: true });
	copyRecursive(PACKAGE_ROOT, pluginDir);

	log("Writing marketplace.json...");
	writeMarketplaceManifest(marketplaceDir, manifest);

	log("Registering marketplace with Codex...");
	runCodex(["plugin", "marketplace", "add", marketplaceDir], { allowFail: true });

	if (flags.force) {
		log("Removing previous installed plugin cache...");
		runCodex(["plugin", "remove", pluginSpec], { allowFail: true });
	}

	log("Installing plugin...");
	runCodex(["plugin", "add", pluginSpec]);

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
	log(`installed ${pluginSpec} v${manifest.version}`);
	log("");
	log("Next steps:");
	log("  1. Restart Codex so it picks up plugin content and hooks");
	log("  2. Run `codex plugin list` and confirm draht@draht is installed");
	log("  3. Use `$draht:<command>` or `/skills` and select the command wrapper");
	log("");
	log("Docs: https://draht.dev");
}

function cmdUninstall(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

	// ~/.draht/bin is a sibling of the marketplace dir, shared across
	// draht-claude/draht-codex/coding-agent, AND its resolved absolute path is
	// baked into every repo's .git/hooks/post-commit (go/internal/hook). Removing
	// it here would silently break graph-engine use in every OTHER package and
	// silently no-op every repo's post-commit hook — so it is opt-in only.
	if (flags.purgeGraphEngine) {
		removeGraphEngine();
		log("Removed ~/.draht/bin/draht-graph (--purge-graph-engine) — draht-claude/coding-agent");
		log("and any repo's post-commit hook that used it will now fall back to the JS engine.");
	} else if (fs.existsSync(GRAPH_BIN_DIR)) {
		log("Leaving ~/.draht/bin/draht-graph in place (shared with draht-claude/coding-agent).");
		log("Remove it too with: npx draht-codex uninstall --purge-graph-engine");
	}

	log("draht-codex uninstaller");
	log(`  marketplace: ${marketplaceDir}`);
	log(`  plugin:      ${pluginSpec}`);
	log("");

	if (hasCodexCli()) {
		log("Removing plugin from Codex...");
		runCodex(["plugin", "remove", pluginSpec], { allowFail: true });
		log("Removing marketplace from Codex...");
		runCodex(["plugin", "marketplace", "remove", MARKETPLACE_NAME], { allowFail: true });
	} else {
		log("(codex CLI not found; skipping Codex registry cleanup)");
	}

	if (fs.existsSync(marketplaceDir)) {
		log(`Removing ${marketplaceDir}...`);
		removeRecursive(marketplaceDir);
	}

	log("");
	log("uninstalled");
}

async function cmdUpdate(flags) {
	await cmdInstall({ ...flags, force: true });
}

function cmdStatus(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const pluginManifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");

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
	} catch (error) {
		log(`status:          files present (manifest unreadable: ${error.message})`);
	}

	if (hasCodexCli()) {
		log("");
		log("Codex plugin list:");
		try {
			const out = execSync("codex plugin list", { encoding: "utf-8" });
			process.stdout.write(out);
		} catch {
			log("  (failed to run `codex plugin list`)");
		}
	}
}

function cmdConfigure(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);
	const agentsDir = path.join(pluginDir, "agents");

	if (!fs.existsSync(pluginDir)) {
		err(`plugin not installed at ${pluginDir}`);
		err("run 'draht-codex install' first");
		process.exit(1);
	}

	if (flags.list) {
		if (!fs.existsSync(agentsDir)) {
			log("no agents directory found");
			return;
		}
		const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
		if (files.length === 0) {
			log("no agents found");
			return;
		}
		log("Agent model metadata:");
		for (const file of files.sort()) {
			const content = fs.readFileSync(path.join(agentsDir, file), "utf-8");
			const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
			let model = "inherit";
			if (match) {
				const modelLine = match[1].split("\n").find((line) => line.trim().startsWith("model:"));
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
			fs.writeFileSync(agentFile, setModelInFrontmatter(content, null));
			log(`reset model metadata for ${flags.agent}`);
		} else {
			if (!fs.existsSync(agentsDir)) return;
			const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
			for (const file of files) {
				const agentFile = path.join(agentsDir, file);
				const content = fs.readFileSync(agentFile, "utf-8");
				fs.writeFileSync(agentFile, setModelInFrontmatter(content, null));
			}
			log("reset model metadata for all agents");
		}
		return;
	}

	if (!flags.agent || !flags.model) {
		err("configure requires --agent <name> and --model <model>");
		err("run 'draht-codex configure --help' for usage");
		process.exit(1);
	}

	const agentFile = path.join(agentsDir, `${flags.agent}.md`);
	if (!fs.existsSync(agentFile)) {
		err(`agent not found: ${flags.agent}`);
		const available = fs.existsSync(agentsDir)
			? fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md")).map((file) => file.replace(".md", "")).join(", ")
			: "(none)";
		err(`available agents: ${available}`);
		process.exit(1);
	}

	const content = fs.readFileSync(agentFile, "utf-8");
	fs.writeFileSync(agentFile, setModelInFrontmatter(content, flags.model));
	log(`set model metadata for ${flags.agent} to ${flags.model}`);
}

function cmdDrahtTools(args) {
	const toolPath = path.join(PACKAGE_ROOT, "bin", "draht-tools.cjs");
	if (!fs.existsSync(toolPath)) {
		err(`bundled draht-tools not found at ${toolPath}`);
		process.exit(1);
	}
	const res = spawnSync(process.execPath, [toolPath, ...args], { stdio: "inherit" });
	process.exit(res.status || 0);
}

const { command, flags, passthrough } = parseArgs(process.argv);

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
		case "draht-tools":
			cmdDrahtTools(passthrough);
			break;
		case "install-graph-engine":
		case "graph-engine":
			await ensureGraphEngine(flags);
			break;
		default:
			err(`unknown command: ${command}`);
			err("run 'draht-codex --help' for usage");
			process.exit(1);
	}
})();
