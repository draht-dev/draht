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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
	const flags = { path: null, force: false, help: false, agent: null, model: null, list: false, reset: false };
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
  npx draht-codex update             Reinstall (same as install --force)
  npx draht-codex status             Show install state
  npx draht-codex configure          Configure bundled reference agent models
    --agent <name> --model <model>   Set model metadata for a specific agent
    --agent <name> --reset           Reset agent model metadata
    --reset                          Reset all agent model metadata
    --list                           List current agent model metadata
  npx draht-codex draht-tools ...    Run the bundled draht-tools CLI

Options:
  -p, --path <dir>   Custom local marketplace directory
  -f, --force        Overwrite existing install
  -h, --help         Show this help

What this installs:
  - Local Codex marketplace named "${MARKETPLACE_NAME}" at ~/.draht/codex-marketplace/
  - Plugin "${PLUGIN_NAME}" inside that marketplace
  - Draht prompt command templates, specialist agent prompts, support skills, hooks, and scripts
  - Self-contained draht-tools CLI

After install, restart Codex. Commands appear under the draht plugin namespace.

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

function cmdInstall(flags) {
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

	log("");
	log(`installed ${pluginSpec} v${manifest.version}`);
	log("");
	log("Next steps:");
	log("  1. Restart Codex so it picks up plugin commands and hooks");
	log("  2. Run `codex plugin list` and confirm draht@draht is installed");
	log("  3. Try a draht command from the slash picker");
	log("");
	log("Docs: https://draht.dev");
}

function cmdUninstall(flags) {
	const marketplaceDir = flags.path || DEFAULT_MARKETPLACE_DIR;
	const pluginSpec = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

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

function cmdUpdate(flags) {
	cmdInstall({ ...flags, force: true });
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
	case "draht-tools":
		cmdDrahtTools(passthrough);
		break;
	default:
		err(`unknown command: ${command}`);
		err("run 'draht-codex --help' for usage");
		process.exit(1);
}
