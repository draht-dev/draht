import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gt, lt } from "semver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeNextVersion, stampPluginManifests } from "../../../scripts/lib/version-stamp.mjs";

describe("computeNextVersion", () => {
	it("returns -1 when there is no release today", () => {
		expect(computeNextVersion([], new Date(2026, 7, 12))).toBe("2026.8.12-1");
	});

	it("increments the suffix when a -N release already exists today", () => {
		expect(computeNextVersion(["2026.8.12-1"], new Date(2026, 7, 12))).toBe("2026.8.12-2");
	});

	it("treats a legacy bare version today as suffix 1, so the next release is -2", () => {
		// Pins the documented transition edge: a bare "YYYY.M.D" produced by the
		// pre-CalVer-suffix release.mjs counts as "-1" for today's max suffix.
		expect(computeNextVersion(["2026.8.12"], new Date(2026, 7, 12))).toBe("2026.8.12-2");
	});

	it("ignores versions from other days", () => {
		expect(computeNextVersion(["2026.8.11-5", "2026.8.13-1"], new Date(2026, 7, 12))).toBe("2026.8.12-1");
	});

	describe("ordering sanity (semver)", () => {
		it("a second same-day release sorts above the first", () => {
			const first = computeNextVersion([], new Date(2026, 7, 12));
			const second = computeNextVersion([first], new Date(2026, 7, 12));

			expect(first).toBe("2026.8.12-1");
			expect(second).toBe("2026.8.12-2");
			expect(gt(second, first)).toBe(true);
		});

		it("documents the one-day transition degradation: -2 sorts below the legacy bare form", () => {
			// The comment on computeNextVersion in version-stamp.mjs claims this
			// degradation as accepted behavior — pin it with a real assertion
			// instead of trusting the prose.
			const next = computeNextVersion(["2026.8.12"], new Date(2026, 7, 12));

			expect(next).toBe("2026.8.12-2");
			expect(lt(next, "2026.8.12")).toBe(true);
		});
	});
});

describe("stampPluginManifests", () => {
	let tempRoot: string;

	const claudeManifestPath = () => join(tempRoot, "packages", "draht-claude", ".claude-plugin", "plugin.json");
	const codexManifestPath = () => join(tempRoot, "packages", "draht-codex", ".codex-plugin", "plugin.json");

	// Fixture shapes are deliberately not identical to each other (codex has an
	// extra "skills" field) so the test cannot pass by assuming both manifests
	// share one shape.
	const claudeFixture = {
		name: "draht",
		version: "2026.1.1-1",
		description: "Fixture claude manifest for stampPluginManifests tests.",
		author: { name: "Fixture Author", url: "https://example.invalid" },
		homepage: "https://example.invalid",
		repository: "https://example.invalid/repo",
		license: "MIT",
		keywords: ["fixture", "claude"],
	};

	const codexFixture = {
		name: "draht",
		version: "2026.1.1-1",
		description: "Fixture codex manifest for stampPluginManifests tests.",
		author: { name: "Fixture Author", url: "https://example.invalid" },
		homepage: "https://example.invalid",
		repository: "https://example.invalid/repo",
		license: "MIT",
		keywords: ["fixture", "codex"],
		skills: "./skills/",
	};

	function writeFixture(path: string, data: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	}

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "version-stamp-test-"));
		writeFixture(claudeManifestPath(), claudeFixture);
		writeFixture(codexManifestPath(), codexFixture);
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("stamps the version field of both plugin manifests", () => {
		stampPluginManifests("2026.1.1-2", tempRoot);

		const claude = JSON.parse(readFileSync(claudeManifestPath(), "utf-8"));
		const codex = JSON.parse(readFileSync(codexManifestPath(), "utf-8"));

		expect(claude.version).toBe("2026.1.1-2");
		expect(codex.version).toBe("2026.1.1-2");
	});

	it("preserves every other field byte-for-byte", () => {
		const beforeClaudeRaw = readFileSync(claudeManifestPath(), "utf-8");
		const beforeCodexRaw = readFileSync(codexManifestPath(), "utf-8");

		stampPluginManifests("2026.1.1-2", tempRoot);

		const afterClaudeRaw = readFileSync(claudeManifestPath(), "utf-8");
		const afterCodexRaw = readFileSync(codexManifestPath(), "utf-8");

		// Reconstruct the expected file text by patching only the version line
		// of the original raw fixture text. Any other drift — key order,
		// indentation, trailing newline, untouched field values — fails this.
		const expectedClaudeRaw = beforeClaudeRaw.replace(
			`"version": "${claudeFixture.version}"`,
			`"version": "2026.1.1-2"`,
		);
		const expectedCodexRaw = beforeCodexRaw.replace(
			`"version": "${codexFixture.version}"`,
			`"version": "2026.1.1-2"`,
		);

		expect(afterClaudeRaw).toBe(expectedClaudeRaw);
		expect(afterCodexRaw).toBe(expectedCodexRaw);
	});

	it("is idempotent: a second call with the same version leaves files byte-identical", () => {
		stampPluginManifests("2026.1.1-2", tempRoot);
		const claudeAfterFirst = readFileSync(claudeManifestPath(), "utf-8");
		const codexAfterFirst = readFileSync(codexManifestPath(), "utf-8");

		stampPluginManifests("2026.1.1-2", tempRoot);
		const claudeAfterSecond = readFileSync(claudeManifestPath(), "utf-8");
		const codexAfterSecond = readFileSync(codexManifestPath(), "utf-8");

		expect(claudeAfterSecond).toBe(claudeAfterFirst);
		expect(codexAfterSecond).toBe(codexAfterFirst);
	});
});
