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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
	const flags = { path: null, force: false, help: false, agent: null, model: null, list: false, reset: false };
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
  npx draht-claude update             Reinstall (same as install --force)
  npx draht-claude status             Show install + enabled state
  npx draht-claude configure          Configure subagent models
    --agent <name> --model <model>    Set model for a specific agent
    --agent <name> --reset            Reset agent to inherit default model
    --reset                           Reset all agents to inherit
    --list                            List current agent model assignments

Options:
  -p, --path <dir>   Custom local marketplace directory
  -f, --force        Overwrite existing install
  -h, --help         Show this help

What this installs:
  • Local Claude Code marketplace named "${MARKETPLACE_NAME}" at ~/.draht/claude-marketplace/
  • Plugin "${PLUGIN_NAME}" inside that marketplace, registered and enabled
  • 16 slash commands (/new-project, /plan-phase, /execute-phase, /orchestrate, ...)
  • 7 specialist subagents (architect, implementer, reviewer, debugger, ...)
  • 3 workflow skills (gsd-workflow, tdd-workflow, ddd-workflow)
  • Workflow hook scripts (pre-execute, post-task, post-phase, quality-gate)
  • Claude Code lifecycle hooks (SessionStart, UserPromptSubmit)
  • Self-contained draht-tools CLI

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
	if (!fs.existsSync(target)) return;
	fs.rmSync(target, { recursive: true, force: true });
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

// ─── commands ───────────────────────────────────────────────────────────────

function cmdInstall(flags) {
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

	// Copy plugin files into marketplace dir
	log("Copying plugin files...");
	if (flags.force && fs.existsSync(pluginDir)) {
		removeRecursive(pluginDir);
	}
	fs.mkdirSync(pluginDir, { recursive: true });
	copyRecursive(PACKAGE_ROOT, pluginDir);

	// Write marketplace manifest
	log("Writing marketplace.json...");
	writeMarketplaceManifest(marketplaceDir, manifest);

	// Validate marketplace + plugin before registering
	log("Validating manifest...");
	runClaude(["plugin", "validate", pluginDir], { allowFail: true });

	// Add marketplace to Claude Code (idempotent — will error if already added, so allow fail)
	log("Registering marketplace with Claude Code...");
	runClaude(["plugin", "marketplace", "add", marketplaceDir], { allowFail: true });

	// Update marketplace so Claude Code picks up any changes to our plugin files on reinstall
	runClaude(["plugin", "marketplace", "update", MARKETPLACE_NAME], { allowFail: true });

	// Install the plugin
	log("Installing plugin...");
	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
	runClaude(["plugin", "install", pluginSpec, "--scope", "user"]);

	// Enable explicitly — install usually enables automatically, but be safe
	runClaude(["plugin", "enable", pluginSpec], { allowFail: true });

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

function cmdUpdate(flags) {
	cmdInstall({ ...flags, force: true });
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

switch (command) {
	case "install":
		cmdInstall(flags);
		break;
	case "uninstall":
	case "remove":
		cmdUninstall(flags);
		break;
	case "update":
	case "upgrade":
		cmdUpdate(flags);
		break;
	case "status":
		cmdStatus(flags);
		break;
	case "configure":
		cmdConfigure(flags);
		break;
	default:
		err(`unknown command: ${command}`);
		err("run 'draht-claude --help' for usage");
		process.exit(1);
}
