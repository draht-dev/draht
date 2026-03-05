/**
 * Tests for src/gsd/hook-utils.ts
 * Toolchain auto-detection and hook configuration reading.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectToolchain, readHookConfig } from "../src/gsd/hook-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-utils-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectToolchain", () => {
	it("detects npm from package-lock.json", () => {
		fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
		const result = detectToolchain(tmpDir);
		expect(result.pm).toBe("npm");
		expect(result.testCmd).toBe("npm test");
		expect(result.coverageCmd).toBe("npm run test:coverage");
		expect(result.lintCmd).toBe("npm run lint");
	});

	it("detects bun from bun.lockb", () => {
		fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
		const result = detectToolchain(tmpDir);
		expect(result.pm).toBe("bun");
		expect(result.testCmd).toBe("bun test");
		expect(result.coverageCmd).toBe("bun test --coverage");
		expect(result.lintCmd).toBe("bunx biome check .");
	});

	it("detects pnpm from pnpm-lock.yaml", () => {
		fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
		const result = detectToolchain(tmpDir);
		expect(result.pm).toBe("pnpm");
		expect(result.testCmd).toBe("pnpm test");
		expect(result.coverageCmd).toBe("pnpm run test:coverage");
		expect(result.lintCmd).toBe("pnpm run lint");
	});

	it("detects yarn from yarn.lock", () => {
		fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
		const result = detectToolchain(tmpDir);
		expect(result.pm).toBe("yarn");
		expect(result.testCmd).toBe("yarn test");
		expect(result.coverageCmd).toBe("yarn run test:coverage");
		expect(result.lintCmd).toBe("yarn run lint");
	});

	it("uses package.json test script as hint (no lockfile)", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
		const result = detectToolchain(tmpDir);
		// Falls back to npm when no lockfile, but acknowledges test script exists
		expect(result.pm).toBe("npm");
		expect(result.testCmd).toBe("npm test");
	});

	it("falls back to npm when no lockfile and no package.json", () => {
		const result = detectToolchain(tmpDir);
		expect(result.pm).toBe("npm");
		expect(result.testCmd).toBe("npm test");
		expect(result.coverageCmd).toBe("npm run test:coverage");
		expect(result.lintCmd).toBe("npm run lint");
	});

	it("returns ToolchainInfo shape", () => {
		const result = detectToolchain(tmpDir);
		expect(result).toHaveProperty("pm");
		expect(result).toHaveProperty("testCmd");
		expect(result).toHaveProperty("coverageCmd");
		expect(result).toHaveProperty("lintCmd");
	});
});

describe("readHookConfig", () => {
	it("returns defaults when .planning/config.json does not exist", () => {
		const result = readHookConfig(tmpDir);
		expect(result.coverageThreshold).toBe(80);
		expect(result.tddMode).toBe("advisory");
		expect(result.qualityGateStrict).toBe(false);
	});

	it("reads hooks section from config.json", () => {
		fs.mkdirSync(path.join(tmpDir, ".planning"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".planning", "config.json"),
			JSON.stringify({
				hooks: {
					coverageThreshold: 90,
					tddMode: "strict",
					qualityGateStrict: true,
				},
			}),
		);
		const result = readHookConfig(tmpDir);
		expect(result.coverageThreshold).toBe(90);
		expect(result.tddMode).toBe("strict");
		expect(result.qualityGateStrict).toBe(true);
	});

	it("falls back to defaults on malformed JSON", () => {
		fs.mkdirSync(path.join(tmpDir, ".planning"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".planning", "config.json"), "not valid json {{");
		const result = readHookConfig(tmpDir);
		expect(result.coverageThreshold).toBe(80);
		expect(result.tddMode).toBe("advisory");
		expect(result.qualityGateStrict).toBe(false);
	});

	it("returns HookConfig shape", () => {
		const result = readHookConfig(tmpDir);
		expect(result).toHaveProperty("coverageThreshold");
		expect(result).toHaveProperty("tddMode");
		expect(result).toHaveProperty("qualityGateStrict");
	});
});
