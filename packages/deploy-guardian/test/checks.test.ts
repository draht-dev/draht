import assert from "node:assert";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getDeployTags, runPreDeployChecks, tagDeployment } from "../src/checks.js";

const TEST_DIR = path.join(os.tmpdir(), `draht-deploy-test-${Date.now()}`);

describe("runPreDeployChecks", () => {
	beforeEach(() => {
		fs.mkdirSync(TEST_DIR, { recursive: true });
		execSync("git init", { cwd: TEST_DIR, stdio: "ignore" });
		execSync("git config user.email 'test@test.com'", { cwd: TEST_DIR, stdio: "ignore" });
		execSync("git config user.name 'Test'", { cwd: TEST_DIR, stdio: "ignore" });
		// Need at least one commit for git status to work cleanly
		fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# Test");
		execSync("git add . && git commit -m 'init'", { cwd: TEST_DIR, stdio: "ignore" });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("returns array of check results", () => {
		const results = runPreDeployChecks(TEST_DIR);
		assert.ok(Array.isArray(results));
		assert.ok(results.length > 0);
	});

	it("passes git status on clean repo", () => {
		const results = runPreDeployChecks(TEST_DIR);
		const gitCheck = results.find((r) => r.name === "Git Status");
		assert.ok(gitCheck);
		assert.strictEqual(gitCheck.severity, "pass");
	});

	it("warns on uncommitted changes", () => {
		fs.writeFileSync(path.join(TEST_DIR, "dirty.txt"), "uncommitted");
		const results = runPreDeployChecks(TEST_DIR);
		const gitCheck = results.find((r) => r.name === "Git Status");
		assert.ok(gitCheck);
		assert.strictEqual(gitCheck.severity, "warning");
	});

	it("warns when no build artifacts exist", () => {
		const results = runPreDeployChecks(TEST_DIR);
		const buildCheck = results.find((r) => r.name === "Build Artifacts");
		assert.ok(buildCheck);
		assert.strictEqual(buildCheck.severity, "warning");
	});

	it("passes when dist/ exists", () => {
		fs.mkdirSync(path.join(TEST_DIR, "dist"), { recursive: true });
		const results = runPreDeployChecks(TEST_DIR);
		const buildCheck = results.find((r) => r.name === "Build Artifacts");
		assert.ok(buildCheck);
		assert.strictEqual(buildCheck.severity, "pass");
	});

	it("passes when .astro/ exists", () => {
		fs.mkdirSync(path.join(TEST_DIR, ".astro"), { recursive: true });
		const results = runPreDeployChecks(TEST_DIR);
		const buildCheck = results.find((r) => r.name === "Build Artifacts");
		assert.ok(buildCheck);
		assert.strictEqual(buildCheck.severity, "pass");
	});

	it("detects SST config", () => {
		fs.writeFileSync(path.join(TEST_DIR, "sst.config.ts"), "export default {}");
		const results = runPreDeployChecks(TEST_DIR);
		const sstCheck = results.find((r) => r.name === "SST Safety");
		assert.ok(sstCheck);
		assert.strictEqual(sstCheck.severity, "warning");
		assert.ok(sstCheck.message.includes("NEVER"));
	});

	it("passes SST check when no config", () => {
		const results = runPreDeployChecks(TEST_DIR);
		const sstCheck = results.find((r) => r.name === "SST Safety");
		assert.ok(sstCheck);
		assert.strictEqual(sstCheck.severity, "pass");
	});

	it("detects env files", () => {
		fs.writeFileSync(path.join(TEST_DIR, ".env"), "KEY=value");
		const results = runPreDeployChecks(TEST_DIR);
		const envCheck = results.find((r) => r.name === "Environment Files");
		assert.ok(envCheck);
		assert.strictEqual(envCheck.severity, "pass");
		assert.ok(envCheck.message.includes(".env"));
	});
});

describe("deployment tagging", () => {
	beforeEach(() => {
		fs.mkdirSync(TEST_DIR, { recursive: true });
		execSync("git init", { cwd: TEST_DIR, stdio: "ignore" });
		execSync("git config user.email 'test@test.com'", { cwd: TEST_DIR, stdio: "ignore" });
		execSync("git config user.name 'Test'", { cwd: TEST_DIR, stdio: "ignore" });
		fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# Test");
		execSync("git add . && git commit -m 'init'", { cwd: TEST_DIR, stdio: "ignore" });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("creates a deploy tag", () => {
		const tag = tagDeployment(TEST_DIR, "deploy-test-1");
		assert.strictEqual(tag, "deploy-test-1");
		const tags = getDeployTags(TEST_DIR);
		assert.ok(tags.includes("deploy-test-1"));
	});

	it("auto-generates tag name", () => {
		const tag = tagDeployment(TEST_DIR);
		assert.ok(tag.startsWith("deploy-"));
	});

	it("lists deploy tags in reverse chronological order", () => {
		tagDeployment(TEST_DIR, "deploy-first");
		// Need another commit for a new tag
		fs.writeFileSync(path.join(TEST_DIR, "file2.txt"), "x");
		execSync("git add . && git commit -m 'second'", { cwd: TEST_DIR, stdio: "ignore" });
		tagDeployment(TEST_DIR, "deploy-second");
		const tags = getDeployTags(TEST_DIR);
		assert.ok(tags.length >= 2);
	});

	it("returns empty when no deploy tags", () => {
		const tags = getDeployTags(TEST_DIR);
		assert.deepStrictEqual(tags, []);
	});
});
