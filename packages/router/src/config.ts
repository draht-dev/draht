import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, type ModelRef, type RoleConfig, type RouterConfig } from "./types.js";

/**
 * Built-in roles that must be present in every config.
 */
export const BUILT_IN_ROLES = ["architect", "implement", "boilerplate", "quick", "review", "docs"] as const;

/**
 * Error thrown when config validation fails.
 * Contains all validation issues found.
 */
export class ConfigValidationError extends Error {
	constructor(public readonly errors: string[]) {
		super(`Config validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
		this.name = "ConfigValidationError";
	}
}

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

/**
 * Validate a ModelRef has non-empty provider and model.
 */
function validateModelRef(ref: ModelRef, role: string, position: string): string[] {
	const errors: string[] = [];
	if (!ref.provider || ref.provider.trim() === "") {
		errors.push(`Empty provider string for role ${role} (${position})`);
	}
	if (!ref.model || ref.model.trim() === "") {
		errors.push(`Empty model string for role ${role} (${position})`);
	}
	return errors;
}

/**
 * Validate a RoleConfig has valid structure.
 */
function validateRoleConfig(roleConfig: RoleConfig, role: string): string[] {
	const errors: string[] = [];

	// Validate primary
	errors.push(...validateModelRef(roleConfig.primary, role, "primary"));

	// Validate fallbacks
	for (let i = 0; i < roleConfig.fallbacks.length; i++) {
		errors.push(...validateModelRef(roleConfig.fallbacks[i], role, `fallback[${i}]`));
	}

	return errors;
}

/**
 * Validate a router config.
 * Throws ConfigValidationError if any issues are found.
 */
export function validateConfig(config: RouterConfig): void {
	const errors: string[] = [];

	// Check all built-in roles are present
	for (const role of BUILT_IN_ROLES) {
		if (!(role in config)) {
			errors.push(`Missing required role: ${role}`);
		}
	}

	// Validate structure of each role config
	for (const [role, roleConfig] of Object.entries(config)) {
		errors.push(...validateRoleConfig(roleConfig, role));
	}

	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}
}
