import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, type RouterConfig } from "./types.js";

const PROJECT_CONFIG = ".draht/router.json";
const GLOBAL_CONFIG = join(homedir(), ".draht", "router.json");

/**
 * Load router config. Project config overrides global, both fall back to defaults.
 */
export function loadConfig(projectRoot?: string): RouterConfig {
	const globalConfig = loadFile(GLOBAL_CONFIG);
	const projectPath = projectRoot ? resolve(projectRoot, PROJECT_CONFIG) : resolve(PROJECT_CONFIG);
	const projectConfig = loadFile(projectPath);

	return mergeConfig(projectConfig, globalConfig);
}

/**
 * Save router config to project or global scope.
 */
export function saveConfig(config: RouterConfig, scope: "project" | "global", projectRoot?: string): void {
	const path =
		scope === "global" ? GLOBAL_CONFIG : projectRoot ? resolve(projectRoot, PROJECT_CONFIG) : resolve(PROJECT_CONFIG);

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, "\t"), "utf-8");
}

/**
 * Merge project config over global config over defaults.
 * Project overrides global per-role.
 */
export function mergeConfig(project: RouterConfig | null, global: RouterConfig | null): RouterConfig {
	const base = { ...DEFAULT_CONFIG };

	if (global) {
		for (const [role, config] of Object.entries(global)) {
			base[role] = config;
		}
	}

	if (project) {
		for (const [role, config] of Object.entries(project)) {
			base[role] = config;
		}
	}

	return base;
}

function loadFile(path: string): RouterConfig | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RouterConfig;
	} catch {
		return null;
	}
}
