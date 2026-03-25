import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getModels, getProviders, type KnownProvider } from "@draht/ai";
import { BUILT_IN_ROLES, DEFAULT_CONFIG, type ModelRef, type RoleConfig, type RouterConfig } from "./types.js";

export { BUILT_IN_ROLES };

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
 * Validate that a project root path is safe and doesn't contain path traversal.
 * Throws if the path attempts to escape the current working directory or uses absolute paths to sensitive areas.
 */
function validateProjectRoot(projectRoot: string): void {
	// Resolve to absolute path to check for traversal
	const resolved = resolve(projectRoot);
	const cwd = resolve(process.cwd());

	// For relative paths: ensure resolved path is within or equal to cwd
	if (!projectRoot.startsWith("/")) {
		if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
			throw new Error(`Invalid project root: path traversal detected (${projectRoot})`);
		}
		return;
	}

	// For absolute paths: allow safe locations (user home, temp dirs, current working directory)
	const home = homedir();
	const tmpDir = tmpdir();
	const safePaths = [home, tmpDir, cwd, "/tmp", "/private/tmp"];
	const isSafe = safePaths.some((safe) => resolved.startsWith(`${safe}/`) || resolved === safe);
	if (isSafe) {
		return;
	}

	// Reject paths to system directories
	const dangerousPaths = ["/etc", "/usr", "/bin", "/sbin", "/sys", "/proc", "/dev", "/boot"];
	for (const dangerous of dangerousPaths) {
		if (resolved.startsWith(dangerous)) {
			throw new Error(`Invalid project root: access to ${dangerous} is not allowed`);
		}
	}

	// Reject any other absolute path that's not explicitly safe
	throw new Error(
		`Invalid project root: absolute path must be within home, temp, or current directory (${projectRoot})`,
	);
}

/**
 * Load router config. Project config overrides global, both fall back to defaults.
 * Validates the merged config and throws ConfigValidationError if invalid.
 */
export function loadConfig(projectRoot?: string): RouterConfig {
	if (projectRoot) {
		validateProjectRoot(projectRoot);
	}

	const globalConfig = loadFile(GLOBAL_CONFIG);
	const projectPath = projectRoot ? resolve(projectRoot, PROJECT_CONFIG) : resolve(PROJECT_CONFIG);
	const projectConfig = loadFile(projectPath);

	const result = mergeConfig(projectConfig, globalConfig);
	validateConfig(result);
	return result;
}

/**
 * Save router config to project or global scope.
 * Validates the config and throws ConfigValidationError if invalid.
 */
export function saveConfig(config: RouterConfig, scope: "project" | "global", projectRoot?: string): void {
	// Validate before writing to ensure we don't save invalid configs
	validateConfig(config);

	if (scope === "project" && projectRoot) {
		validateProjectRoot(projectRoot);
	}

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
 * Validate a ModelRef against the @draht/ai registry.
 * Returns errors if provider or model is not found.
 */
function validateModelRefAgainstRegistry(
	ref: ModelRef,
	role: string,
	position: string,
	validProviders: Set<string>,
): string[] {
	const errors: string[] = [];

	// Skip if empty (already caught by structure validation)
	if (!ref.provider || !ref.model) {
		return errors;
	}

	// Check provider exists
	if (!validProviders.has(ref.provider)) {
		errors.push(`Invalid provider '${ref.provider}' for role ${role} (not in @draht/ai registry)`);
		return errors; // Don't check model if provider is invalid
	}

	// Check model exists for this provider
	const models = getModels(ref.provider as KnownProvider);
	const modelExists = models.some((m) => m.id === ref.model);
	if (!modelExists) {
		errors.push(`Invalid model '${ref.model}' for provider '${ref.provider}' in role ${role} (${position})`);
	}

	return errors;
}

/**
 * Validate a RoleConfig against the @draht/ai registry.
 */
function validateRoleConfigAgainstRegistry(
	roleConfig: RoleConfig,
	role: string,
	validProviders: Set<string>,
): string[] {
	const errors: string[] = [];

	// Validate primary
	errors.push(...validateModelRefAgainstRegistry(roleConfig.primary, role, "primary", validProviders));

	// Validate fallbacks
	for (let i = 0; i < roleConfig.fallbacks.length; i++) {
		errors.push(...validateModelRefAgainstRegistry(roleConfig.fallbacks[i], role, `fallback[${i}]`, validProviders));
	}

	return errors;
}

/**
 * Format a ModelRef as "provider/model" for display.
 */
function formatModelRefForValidation(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

/**
 * Detect duplicate models in a fallback chain (primary + fallbacks).
 */
function detectDuplicateModels(roleConfig: RoleConfig, role: string): string[] {
	const errors: string[] = [];
	const allModels: ModelRef[] = [roleConfig.primary, ...roleConfig.fallbacks];
	const seen = new Set<string>();

	for (const ref of allModels) {
		const key = formatModelRefForValidation(ref);
		if (seen.has(key)) {
			errors.push(`Duplicate model ${key} in fallback chain for role ${role}`);
		}
		seen.add(key);
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

	// Cache valid providers for registry validation
	const validProviders = new Set(getProviders());

	// Validate each role config against registry
	for (const [role, roleConfig] of Object.entries(config)) {
		errors.push(...validateRoleConfigAgainstRegistry(roleConfig, role, validProviders));
	}

	// Detect duplicate models in fallback chains
	for (const [role, roleConfig] of Object.entries(config)) {
		errors.push(...detectDuplicateModels(roleConfig, role));
	}

	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}
}
