import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "scripts", "fixtures", "cinematic-continuation");
const PACKAGES = ["draht-claude", "draht-codex"];
const SKILL_FILES = [
	"SKILL.md",
	"references/style-bible.md",
	"references/continuity-schema.md",
	"references/seedance-adapter.md",
	"templates/continuation-spec.json",
	"scripts/compile-continuation.mjs",
];

function packageSkill(packageName) {
	return join(ROOT, "packages", packageName, "skills", "cinematic-continuation");
}

function runCompiler(packageName, fixture) {
	return spawnSync(process.execPath, [join(packageSkill(packageName), "scripts", "compile-continuation.mjs"), join(FIXTURES, fixture)], {
		encoding: "utf8",
	});
}

test("Claude and Codex package artifacts include the complete cinematic continuation skill", () => {
	for (const packageName of PACKAGES) {
		const result = spawnSync("npm", ["pack", "--dry-run", "--json", `./${join("packages", packageName)}`], {
			cwd: ROOT,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const parsed = JSON.parse(result.stdout);
		const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
		const files = new Set(pack.files.map(({ path }) => path));
		for (const relative of SKILL_FILES) {
			assert.equal(files.has(`skills/cinematic-continuation/${relative}`), true, `${packageName} package is missing ${relative}`);
		}
	}
});

test("marketplace skill bundle is portable and provider-neutral", () => {
	for (const packageName of PACKAGES) {
		for (const relative of SKILL_FILES) {
			const content = readFileSync(join(packageSkill(packageName), relative), "utf8");
			assert.doesNotMatch(content, /\/(?:srv|home)\//, `${packageName}/${relative} contains a machine-specific absolute path`);
			assert.doesNotMatch(content, /\bpi-[a-z0-9-]*/i, `${packageName}/${relative} introduces a legacy public artifact name`);
		}
		const skill = readFileSync(join(packageSkill(packageName), "SKILL.md"), "utf8");
		assert.match(skill, /gpt-5\.6-luna[^\n]*unavailable/i);
		assert.match(skill, /gpt-5\.6-sol/);
		assert.match(skill, /provider-neutral/i);
	}
});

test("compiler accepts a contiguous timeline and emits a neutral prompt plus an adapter boundary", () => {
	for (const packageName of PACKAGES) {
		const output = mkdtempSync(join(tmpdir(), "draht-cinematic-compile-"));
		try {
			const result = spawnSync(process.execPath, [
				join(packageSkill(packageName), "scripts", "compile-continuation.mjs"),
				join(FIXTURES, "valid-sequence.json"),
				"--output",
				join(output, "compiled.json"),
			], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			const compiled = JSON.parse(readFileSync(join(output, "compiled.json"), "utf8"));
			assert.equal(compiled.sequence_id, "continuation-test-001");
			assert.match(compiled.master_prompt, /0\.00-2\.50s/);
			assert.match(compiled.master_prompt, /2\.50-6\.00s/);
			assert.equal(compiled.provider_adapters.seedance_2_5.duration_seconds, 6);
			assert.equal("endpoint" in compiled.provider_adapters.seedance_2_5, false);
		} finally {
			rmSync(output, { recursive: true, force: true });
		}
	}
});

test("compiler rejects timeline gaps with an actionable validation error", () => {
	for (const packageName of PACKAGES) {
		const result = runCompiler(packageName, "gapped-sequence.json");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /shot 1 must start at 2(?:\.0)?; got 2\.5/i);
	}
});
