// GSD Hook Utilities — toolchain auto-detection and hook configuration.
// Mirrors the inline logic in hooks/gsd/*.js so it can be tested via vitest.
// The hook .js files embed the same logic inline (with require() fallback to this dist).

import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolchainInfo {
	pm: "npm" | "bun" | "pnpm" | "yarn";
	testCmd: string;
	coverageCmd: string;
	lintCmd: string;
}

export interface HookConfig {
	coverageThreshold: number;
	tddMode: "strict" | "advisory";
	qualityGateStrict: boolean;
}

const DEFAULT_HOOK_CONFIG: HookConfig = {
	coverageThreshold: 80,
	tddMode: "advisory",
	qualityGateStrict: false,
};

/**
 * Detect package manager from lockfiles and package.json scripts.
 * Priority: bun.lockb/bun.lock > pnpm-lock.yaml > yarn.lock > package-lock.json > fallback npm
 */
export function detectToolchain(cwd: string): ToolchainInfo {
	if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
		return {
			pm: "bun",
			testCmd: "bun test",
			coverageCmd: "bun test --coverage",
			lintCmd: "bunx biome check .",
		};
	}

	if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
		return {
			pm: "pnpm",
			testCmd: "pnpm test",
			coverageCmd: "pnpm run test:coverage",
			lintCmd: "pnpm run lint",
		};
	}

	if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
		return {
			pm: "yarn",
			testCmd: "yarn test",
			coverageCmd: "yarn run test:coverage",
			lintCmd: "yarn run lint",
		};
	}

	if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
		return {
			pm: "npm",
			testCmd: "npm test",
			coverageCmd: "npm run test:coverage",
			lintCmd: "npm run lint",
		};
	}

	// No lockfile — check package.json scripts for test runner hints
	const pkgPath = path.join(cwd, "package.json");
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
				scripts?: Record<string, string>;
			};
			if (pkg.scripts?.test) {
				return {
					pm: "npm",
					testCmd: "npm test",
					coverageCmd: "npm run test:coverage",
					lintCmd: "npm run lint",
				};
			}
		} catch {
			/* ignore parse errors */
		}
	}

	// Fallback
	return {
		pm: "npm",
		testCmd: "npm test",
		coverageCmd: "npm run test:coverage",
		lintCmd: "npm run lint",
	};
}

/**
 * Read hook configuration from .planning/config.json hooks section.
 * Falls back to defaults on missing file or parse errors.
 */
export function readHookConfig(cwd: string): HookConfig {
	const configPath = path.join(cwd, ".planning", "config.json");
	if (!fs.existsSync(configPath)) {
		return { ...DEFAULT_HOOK_CONFIG };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			hooks?: Partial<HookConfig>;
		};
		const hooks = raw.hooks ?? {};
		return {
			coverageThreshold:
				typeof hooks.coverageThreshold === "number"
					? hooks.coverageThreshold
					: DEFAULT_HOOK_CONFIG.coverageThreshold,
			tddMode:
				hooks.tddMode === "strict" || hooks.tddMode === "advisory" ? hooks.tddMode : DEFAULT_HOOK_CONFIG.tddMode,
			qualityGateStrict:
				typeof hooks.qualityGateStrict === "boolean"
					? hooks.qualityGateStrict
					: DEFAULT_HOOK_CONFIG.qualityGateStrict,
		};
	} catch {
		return { ...DEFAULT_HOOK_CONFIG };
	}
}
