import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".draht", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".draht", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".draht", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".draht"), { recursive: true });
			writeFileSync(join(cwd, ".draht", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".draht"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	// Regression test for https://github.com/badlogic/pi-mono/issues/10488
	// draht resolves HOME through the filesystem (realHomeDir) and treats an unresolvable HOME as unknown, so the
	// lowercased HOME only names the same directory on a case-insensitive filesystem: run this on real Windows.
	it.skipIf(process.platform !== "win32")(
		"ignores the user .agents/skills dir when HOME differs only by case on Windows",
		() => {
			const originalHome = process.env.HOME;
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
			const mixedCaseHome = join(tempDir, "Home");
			const projectDir = join(mixedCaseHome, "project");
			mkdirSync(join(mixedCaseHome, ".agents", "skills"), { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			process.env.HOME = mixedCaseHome.toLowerCase();
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				expect(hasTrustRequiringProjectResources(projectDir)).toBe(false);
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
				if (originalHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = originalHome;
				}
			}
		},
	);

	// Regression test for https://github.com/badlogic/pi-mono/issues/10488
	it("matches saved decisions regardless of casing on Windows", () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		const projectDir = join(tempDir, "Project-Mixed");
		mkdirSync(projectDir, { recursive: true });
		const store = new ProjectTrustStore(agentDir);
		// draht: a stored trust binds only where the key resolves to the config-loading directory, which a lowercased
		// spelling cannot on this case-sensitive test filesystem; a stored refusal always binds. So the case-insensitive
		// lookup is asserted with a refusal, and the case-insensitive replacement by storing trust under the other casing.
		store.set(projectDir, false);
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(store.get(projectDir.toLowerCase())).toBe(false);
			store.set(projectDir.toLowerCase(), true);
			const saved = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<string, boolean>;
			expect(Object.values(saved)).toEqual([true]);
			expect(store.get(projectDir)).toBe(true);
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});
});
