import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countTokens } from "../src/core/budgets/policy.ts";
import { auditBudget, beginTask, checkBudget } from "../src/core/budgets/runtime.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("shared task token budgets", () => {
	let root: string;
	let repo: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-budget-"));
		repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--initial-branch=main");
		git(repo, "config", "user.name", "Budget tests");
		git(repo, "config", "user.email", "budgets@example.invalid");
		configure({});
	});

	afterEach(() => rmSync(root, { force: true, recursive: true }));

	function configure(value: Record<string, unknown>, directory = repo) {
		mkdirSync(join(directory, ".draht"), { recursive: true });
		writeFileSync(join(directory, ".draht", "budgets.json"), JSON.stringify(value));
	}

	function ledgerFiles(): string[] {
		return readdirSync(join(repo, ".git")).filter((name) => name.startsWith("draht-budgets"));
	}

	it("does nothing in a repository without budget configuration", () => {
		rmSync(join(repo, ".draht"), { recursive: true });
		const content = "export const value = 1;\n".repeat(2000);
		expect(beginTask({ cwd: repo }).status).toBe("disabled");
		expect(checkBudget({ cwd: repo, proposed: [{ path: "large.ts", content }] }).status).toBe("disabled");
		writeFileSync(join(repo, "large.ts"), content);
		const audit = auditBudget({ cwd: repo });
		expect(audit.status).toBe("disabled");
		expect(audit.taskId).toBeUndefined();
		expect(ledgerFiles()).toEqual([]);
	});

	it("starts at the dirty working tree without changing the user's index or HEAD", () => {
		writeFileSync(join(repo, "code.ts"), "export const value = 1;\n");
		git(repo, "add", "code.ts");
		git(repo, "commit", "-m", "initial");
		writeFileSync(join(repo, "code.ts"), "export const value = 2;\n");
		git(repo, "add", "code.ts");
		writeFileSync(join(repo, "code.ts"), "export const value = 3;\n");
		writeFileSync(join(repo, "notes.md"), "Existing user notes\n");
		const index = git(repo, "ls-files", "--stage");
		const head = git(repo, "rev-parse", "HEAD");
		const status = git(repo, "status", "--porcelain");

		const report = beginTask({ cwd: repo });

		expect(report).toMatchObject({ status: "passed", usage: { codeTokens: 0, docTokens: 0 } });
		expect(git(repo, "ls-files", "--stage")).toBe(index);
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
		expect(git(repo, "status", "--porcelain")).toBe(status);
	});

	it("counts replacement tokens on both sides and separates untracked documentation", () => {
		const before = "export const before = true;\n";
		const after = "export const after = false;\n";
		writeFileSync(join(repo, "code.ts"), before);
		beginTask({ cwd: repo });
		writeFileSync(join(repo, "code.ts"), after);
		writeFileSync(join(repo, "notes.md"), "New documentation\n");

		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: {
				codeTokens: countTokens(before) + countTokens(after),
				docTokens: countTokens("New documentation\n"),
			},
		});
	});

	it("defaults to code and documentation file ceilings with optional task totals disabled", () => {
		const initial = beginTask({ cwd: repo });
		expect(initial.limits).toEqual({
			maxFileTokens: 5000,
			maxDocFileTokens: 1500,
			maxCodeTokens: null,
			maxDocTokens: null,
			maxOversizedGrowthTokens: 250,
		});
		const content = "word\n".repeat(800);
		expect(countTokens(content)).toBeGreaterThan(initial.limits.maxDocFileTokens);
		const projected = checkBudget({ cwd: repo, proposed: [{ path: "notes.md", content }] });
		expect(projected.status).toBe("failed");
		expect(projected.violations.join(" ")).toContain("notes.md");
		expect(existsSync(join(repo, "notes.md"))).toBe(false);
		writeFileSync(join(repo, "notes.md"), content);
		expect(auditBudget({ cwd: repo }).status).toBe("failed");
	});

	it("allows many files below their ceilings even when aggregate usage exceeds the former task defaults", () => {
		beginTask({ cwd: repo });
		const code = "value\n".repeat(2000);
		const docs = "word\n".repeat(600);
		expect(countTokens(code)).toBeLessThanOrEqual(5000);
		expect(countTokens(docs)).toBeLessThanOrEqual(1500);
		for (let index = 0; index < 6; index++) writeFileSync(join(repo, `code-${index}.ts`), code);
		for (let index = 0; index < 5; index++) writeFileSync(join(repo, `notes-${index}.md`), docs);
		const report = auditBudget({ cwd: repo });
		expect(report.status).toBe("passed");
		expect(report.usage.codeTokens).toBeGreaterThan(20_000);
		expect(report.usage.docTokens).toBeGreaterThan(5000);
	});

	it("freezes existing oversized documentation when the growth allowance is zero", () => {
		configure({ maxDocFileTokens: 8, maxOversizedGrowthTokens: 0 });
		const before = "existing documentation\n".repeat(5);
		writeFileSync(join(repo, "notes.md"), before);
		expect(beginTask({ cwd: repo }).status).toBe("passed");
		expect(
			checkBudget({ cwd: repo, proposed: [{ path: "notes.md", content: `${before}More details\n` }] }).status,
		).toBe("failed");
		const smaller = "existing documentation\n".repeat(4);
		expect(countTokens(smaller)).toBeGreaterThan(8);
		expect(checkBudget({ cwd: repo, proposed: [{ path: "notes.md", content: smaller }] }).status).toBe("passed");
		writeFileSync(join(repo, "notes.md"), smaller);
		expect(auditBudget({ cwd: repo }).status).toBe("passed");
	});

	it("lets an existing oversized file grow by the configured allowance", () => {
		configure({ maxFileTokens: 10, maxOversizedGrowthTokens: 5 });
		const before = "const value = 123;\n".repeat(4);
		writeFileSync(join(repo, "legacy.ts"), before);
		beginTask({ cwd: repo });
		const ceiling = countTokens(before) + 5;
		const within = `${before}x;\n`;
		expect(countTokens(within)).toBeLessThanOrEqual(ceiling);
		expect(checkBudget({ cwd: repo, proposed: [{ path: "legacy.ts", content: within }] }).status).toBe("passed");
		const beyond = `${before}const more = 1;\n`;
		expect(countTokens(beyond)).toBeGreaterThan(ceiling);
		const report = checkBudget({ cwd: repo, proposed: [{ path: "legacy.ts", content: beyond }] });
		expect(report.violations).toEqual([
			`legacy.ts: ${countTokens(beyond)} code tokens exceed file ceiling ${ceiling}`,
		]);
	});

	it("skips lockfiles, changelogs, generated files and excluded globs", () => {
		configure({ maxFileTokens: 5, maxDocFileTokens: 5, exclude: ["vendor/", "*.snap"] });
		writeFileSync(join(repo, ".gitattributes"), "gen/** linguist-generated\n");
		git(repo, "add", ".gitattributes", ".draht/budgets.json");
		git(repo, "commit", "-m", "attributes");
		beginTask({ cwd: repo });
		const large = "export const value = 123456789;\n".repeat(20);
		mkdirSync(join(repo, "gen"));
		mkdirSync(join(repo, "vendor"));
		for (const path of ["CHANGELOG.md", "package-lock.json", "bun.lock", "gen/api.ts", "vendor/lib.js", "ui.snap"]) {
			writeFileSync(join(repo, path), large);
		}
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", usage: { codeTokens: 0, docTokens: 0 } });
		expect(checkBudget({ cwd: repo, proposed: [{ path: "gen/next.ts", content: large }] }).status).toBe("passed");
		// Attributes come from the commit checked out at task start, so marking a file generated later changes nothing.
		writeFileSync(join(repo, ".gitattributes"), "gen/** linguist-generated\nsrc/** linguist-generated\n");
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "main.ts"), large);
		expect(auditBudget({ cwd: repo }).violations.join(" ")).toContain("src/main.ts");
	});

	it("refuses projected file and task excess without writing the file or charging the rejected change", () => {
		configure({ maxFileTokens: 5, maxCodeTokens: 12 });
		beginTask({ cwd: repo });
		const content = "export const importantValue = 123456789;\n";
		const report = checkBudget({ cwd: repo, proposed: [{ path: "new.ts", content }] });

		expect(report.status).toBe("failed");
		expect(report.taskId).toBeTruthy();
		expect(report.violations.join(" ")).toContain("new.ts");
		expect(existsSync(join(repo, "new.ts"))).toBe(false);
		expect(auditBudget({ cwd: repo }).usage).toEqual({ codeTokens: 0, docTokens: 0 });
	});

	it.each(["task", "worktree"])(
		"checks the first proposed edit of a new %s against its starting snapshot",
		(scope) => {
			configure({ maxFileTokens: 5 });
			let cwd = repo;
			if (scope === "worktree") {
				git(repo, "add", ".draht/budgets.json");
				git(repo, "commit", "-m", "initial");
				beginTask({ cwd: repo });
				cwd = join(root, "child");
				git(repo, "worktree", "add", "-b", "child", cwd);
			}
			const content = "export const value = 123456789;\n";
			const report = checkBudget({ cwd, proposed: [{ path: "large.ts", content }] });
			expect(report.status).toBe("failed");
			expect(report.violations).toEqual([`large.ts: ${countTokens(content)} code tokens exceed file ceiling 5`]);
		},
	);

	it("keeps the baseline through commits and resumes, resetting only on an explicit new task", () => {
		writeFileSync(join(repo, "code.ts"), "before\n");
		git(repo, "add", "code.ts");
		git(repo, "commit", "-m", "initial");
		const first = beginTask({ cwd: repo });
		writeFileSync(join(repo, "code.ts"), "after\n");
		git(repo, "add", "code.ts");
		git(repo, "commit", "-m", "agent change");
		const resumed = beginTask({ cwd: repo });

		expect(resumed.taskId).toBe(first.taskId);
		expect(resumed.usage.codeTokens).toBe(countTokens("before\n") + countTokens("after\n"));
		const next = beginTask({ cwd: repo, newTask: true });
		expect(next.taskId).not.toBe(first.taskId);
		expect(next.usage).toEqual({ codeTokens: 0, docTokens: 0 });
	});

	it("allows an incremental repair but keeps the final audit failed until excess is removed", () => {
		configure({ maxFileTokens: 10, maxCodeTokens: 12 });
		beginTask({ cwd: repo });
		const content = "const value = 123;\n".repeat(10);
		writeFileSync(join(repo, "oversized.ts"), content);
		expect(auditBudget({ cwd: repo }).status).toBe("failed");

		const repair = checkBudget({ cwd: repo, proposed: [{ path: "oversized.ts", content: content.slice(0, -19) }] });
		expect(repair.status).toBe("passed");
		expect(readFileSync(join(repo, "oversized.ts"), "utf8")).toBe(content);
		expect(auditBudget({ cwd: repo }).status).toBe("failed");
	});

	it.each(["code", "documentation"])(
		"shares an optional %s task cap across parent and child worktrees",
		(category) => {
			const limit = category === "code" ? "maxCodeTokens" : "maxDocTokens";
			const usage = category === "code" ? "codeTokens" : "docTokens";
			const extension = category === "code" ? "ts" : "md";
			configure({ [limit]: 5 });
			git(repo, "add", ".draht/budgets.json");
			git(repo, "commit", "-m", "initial");
			const first = beginTask({ cwd: repo });
			const child = join(root, "child");
			git(repo, "worktree", "add", "-b", "child", child);
			expect(beginTask({ cwd: child }).taskId).toBe(first.taskId);
			writeFileSync(join(repo, `parent.${extension}`), "parent change\n");
			writeFileSync(join(child, `child.${extension}`), "child change\n");

			const report = auditBudget({ cwd: repo });
			expect(report.status).toBe("failed");
			expect(report.usage[usage]).toBe(countTokens("parent change\n") + countTokens("child change\n"));
			git(child, "add", `child.${extension}`);
			git(child, "commit", "-m", "child change");
			git(repo, "worktree", "remove", child);
			expect(auditBudget({ cwd: repo }).usage).toEqual(report.usage);
		},
	);

	it("deduplicates an identical child patch when it is merged into the parent", () => {
		writeFileSync(join(repo, "code.ts"), "before\n");
		git(repo, "add", "code.ts");
		git(repo, "commit", "-m", "initial");
		beginTask({ cwd: repo });
		const child = join(root, "child");
		git(repo, "worktree", "add", "-b", "child", child);
		beginTask({ cwd: child });
		writeFileSync(join(child, "code.ts"), "after\n");
		const beforeMerge = auditBudget({ cwd: child });
		git(child, "add", "code.ts");
		git(child, "commit", "-m", "child change");
		git(repo, "merge", "--ff-only", "child");

		expect(auditBudget({ cwd: repo }).usage).toEqual(beforeMerge.usage);
	});

	it("freezes policy for the task and applies changed configuration to an explicit new task", () => {
		configure({ maxDocTokens: 3 });
		const first = beginTask({ cwd: repo });
		configure({ enabled: false });
		writeFileSync(join(repo, "notes.md"), "many new documentation tokens\n");
		const audit = auditBudget({ cwd: repo });

		expect(audit.status).toBe("failed");
		expect(audit.taskId).toBe(first.taskId);
		expect(audit.limits.maxDocTokens).toBe(3);
		expect(beginTask({ cwd: repo, newTask: true }).status).toBe("disabled");
	});

	it("reports malformed configuration and damaged or deleted ledgers as errors until the user starts a new task", () => {
		configure({ maxCodeTokens: "unlimited" });
		const invalid = beginTask({ cwd: repo });
		expect(invalid.status).toBe("error");
		expect(invalid.taskId).toBeUndefined();
		configure({});
		const first = beginTask({ cwd: repo });
		expect(first.status).toBe("passed");
		const ledger = join(repo, ".git", "draht-budgets", "task.json");
		writeFileSync(ledger, "{}");
		const corrupted = auditBudget({ cwd: repo });
		expect(corrupted.status).toBe("error");
		expect(corrupted.taskId).toBeUndefined();
		rmSync(join(repo, ".git", "draht-budgets"), { recursive: true });
		expect(auditBudget({ cwd: repo }).summary).toContain("incomplete");
		const next = beginTask({ cwd: repo, newTask: true });
		expect(next.status).toBe("passed");
		expect(next.taskId).not.toBe(first.taskId);
	});

	it("keeps the current task when a new task's configuration is invalid", () => {
		const first = beginTask({ cwd: repo });
		configure({ maxFileTokens: 0 });
		expect(beginTask({ cwd: repo, newTask: true }).status).toBe("error");
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", taskId: first.taskId });
	});

	it("clears the task and its stored snapshots when a new task finds no configuration", () => {
		writeFileSync(join(repo, "code.ts"), "before\n");
		beginTask({ cwd: repo });
		expect(ledgerFiles().sort()).toEqual(["draht-budgets", "draht-budgets.task"]);
		rmSync(join(repo, ".draht"), { recursive: true });
		expect(auditBudget({ cwd: repo }).status).toBe("passed");
		expect(beginTask({ cwd: repo, newTask: true }).status).toBe("disabled");
		expect(ledgerFiles()).toEqual([]);
	});

	it("ignores non-Git directories without budgets and reports configured ones as errors", () => {
		const outside = join(root, "outside");
		mkdirSync(join(outside, "subdir"), { recursive: true });
		expect(beginTask({ cwd: outside }).status).toBe("disabled");
		configure({}, outside);
		expect(beginTask({ cwd: outside }).status).toBe("error");
		expect(beginTask({ cwd: join(outside, "subdir") }).summary).toContain("Git working tree");
	});

	it("does not charge edits outside the measured files but refuses edits to its own ledger", () => {
		configure({ maxFileTokens: 1, maxCodeTokens: 1 });
		writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(repo, "linked"));
		mkdirSync(join(repo, "nested"));
		git(join(repo, "nested"), "init");
		beginTask({ cwd: repo });
		for (const path of ["../outside/code.ts", "linked/code.ts", ".git/config", "nested/code.ts", "ignored.ts"]) {
			const report = checkBudget({ cwd: repo, proposed: [{ path, content: "hello world again" }] });
			expect(report, path).toMatchObject({ status: "passed", usage: { codeTokens: 0 } });
		}
		for (const path of [".git/draht-budgets/task.json", ".git/draht-budgets.task"]) {
			const report = checkBudget({ cwd: repo, proposed: [{ path, content: "{}" }] });
			expect(report.status, path).toBe("failed");
			expect(report.summary, path).toContain("ledger");
		}
	});

	it("stops measuring files that Git starts ignoring or a nested repository takes over, without charging removals", () => {
		configure({ maxFileTokens: 10, maxOversizedGrowthTokens: 0 });
		const large = "export const value = 123456789;\n".repeat(3);
		mkdirSync(join(repo, "vendor"));
		for (const path of ["build.js", "vendor/lib.js"]) writeFileSync(join(repo, path), large);
		beginTask({ cwd: repo });
		for (const path of ["build.js", "vendor/lib.js"]) writeFileSync(join(repo, path), `${large}${large}`);
		expect(auditBudget({ cwd: repo }).violations).toHaveLength(2);
		writeFileSync(join(repo, ".gitignore"), "build.js\n");
		git(join(repo, "vendor"), "init");
		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens("build.js\n") },
		});
	});

	it("measures a starting file against its starting content again once Git stops ignoring it", () => {
		configure({ maxFileTokens: 10, maxOversizedGrowthTokens: 0 });
		const large = "export const value = 123456789;\n".repeat(3);
		writeFileSync(join(repo, "build.js"), large);
		beginTask({ cwd: repo });
		writeFileSync(join(repo, ".gitignore"), "build.js\n");
		writeFileSync(join(repo, "build.js"), `${large}${large}`);
		expect(auditBudget({ cwd: repo }).status).toBe("passed");
		writeFileSync(join(repo, "build.js"), large);
		writeFileSync(join(repo, ".gitignore"), "");
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", usage: { codeTokens: 0 } });
		writeFileSync(join(repo, "build.js"), `${large}x;\n`);
		expect(auditBudget({ cwd: repo }).violations).toEqual([
			`build.js: ${countTokens(`${large}x;\n`)} code tokens exceed file ceiling ${countTokens(large)}`,
		]);
	});

	it("measures edits through a symlinked session directory as the repository's own files", () => {
		configure({ maxFileTokens: 5 });
		const link = join(root, "link");
		symlinkSync(repo, link);
		beginTask({ cwd: link });
		const small = checkBudget({ cwd: link, proposed: [{ path: join(link, "small.ts"), content: "hello" }] });
		expect(small).toMatchObject({ status: "passed", usage: { codeTokens: countTokens("hello") } });
		const large = checkBudget({ cwd: link, proposed: [{ path: "large.ts", content: "hello world ".repeat(5) }] });
		expect(large.violations.join(" ")).toContain("large.ts");
	});

	it("counts raw text without invoking Git filters and excludes binary content", () => {
		writeFileSync(join(repo, ".gitattributes"), "*.ts filter=hostile\n");
		git(repo, "config", "filter.hostile.clean", "exit 31");
		git(repo, "config", "filter.hostile.required", "true");
		writeFileSync(join(repo, "code.ts"), "before\r\n");
		beginTask({ cwd: repo });
		writeFileSync(join(repo, "code.ts"), "after\r\n");
		writeFileSync(join(repo, "data.bin"), Buffer.from([0, 255, 100, 5]));

		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens("before\r\n") + countTokens("after\r\n"), docTokens: 0 },
		});
	});

	it("counts NUL characters in proposed and actual source or documentation files", () => {
		configure({ maxFileTokens: 2, maxDocTokens: 2 });
		beginTask({ cwd: repo });
		const content = "hello\0world\n".repeat(5);
		expect(checkBudget({ cwd: repo, proposed: [{ path: "code.ts", content }] }).status).toBe("failed");
		writeFileSync(join(repo, "code.ts"), content);
		writeFileSync(join(repo, "notes.md"), content);
		const report = auditBudget({ cwd: repo });
		expect(report.status).toBe("failed");
		expect(report.usage).toEqual({ codeTokens: countTokens(content), docTokens: countTokens(content) });
	});

	it("counts source with invalid UTF-8 lossily instead of failing or skipping it", () => {
		writeFileSync(join(repo, "notes.txt"), Buffer.from("caf\xe9\n", "latin1"));
		expect(beginTask({ cwd: repo }).status).toBe("passed");
		writeFileSync(join(repo, "code.ts"), Buffer.from([0xff, 0x61]));
		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens("\ufffda") },
		});
	});

	it("preserves whitespace in repository paths and resolves edits relative to the invoking directory", () => {
		const spaced = join(root, "repo with space ");
		mkdirSync(join(spaced, "src"), { recursive: true });
		git(spaced, "init");
		configure({}, spaced);
		expect(beginTask({ cwd: spaced }).status).toBe("passed");
		const report = checkBudget({ cwd: join(spaced, "src"), proposed: [{ path: "code.ts", content: "hello" }] });
		expect(report.status).toBe("passed");
		expect(report.usage.codeTokens).toBe(countTokens("hello"));
	});

	it("reports a corrupted content object as an error that a new task repairs", () => {
		writeFileSync(join(repo, "code.ts"), "before\n");
		beginTask({ cwd: repo });
		const objects = join(repo, ".git", "draht-budgets", "objects");
		for (const object of readdirSync(objects)) writeFileSync(join(objects, object), "corrupt");
		writeFileSync(join(repo, "code.ts"), "after\n");
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "error" });
		expect(beginTask({ cwd: repo, newTask: true }).status).toBe("passed");
		writeFileSync(join(repo, "code.ts"), "again\n");
		expect(auditBudget({ cwd: repo }).status).toBe("passed");
	});

	it("keeps a removed worktree's usage without blocking the parent on its files", () => {
		configure({ maxFileTokens: 5 });
		git(repo, "add", ".draht/budgets.json");
		git(repo, "commit", "-m", "initial");
		beginTask({ cwd: repo });
		const child = join(root, "child");
		git(repo, "worktree", "add", "-b", "child", child);
		beginTask({ cwd: child });
		const content = "export const value = 123456789;\n";
		writeFileSync(join(child, "large.ts"), content);
		expect(auditBudget({ cwd: repo }).violations).toEqual([
			`large.ts in worktree ${child}: ${countTokens(content)} code tokens exceed file ceiling 5`,
		]);
		git(repo, "worktree", "remove", "--force", child);
		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens(content) },
		});
	});

	function leaveDeadLock(): string {
		const lock = join(repo, ".git", "draht-budgets.lock");
		const stateUrl = new URL("../src/core/budgets/state.ts", import.meta.url).href;
		execFileSync(
			process.execPath,
			[
				"--import",
				createRequire(import.meta.url).resolve("tsx"),
				"--input-type=module",
				"-e",
				`import { withBudgetLock } from ${JSON.stringify(stateUrl)}; withBudgetLock(${JSON.stringify(lock)}, () => process.exit(0));`,
			],
			{ timeout: 10_000, stdio: "pipe" },
		);
		return lock;
	}

	it("recovers a lock left by a terminated process without resetting the task", () => {
		const initial = beginTask({ cwd: repo });
		leaveDeadLock();
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", taskId: initial.taskId });
	}, 15_000);

	it("clears a recovery marker left by a process that died while recovering a lock", () => {
		const initial = beginTask({ cwd: repo });
		const lock = leaveDeadLock();
		mkdirSync(`${lock}.recovery`);
		const stale = new Date(Date.now() - 60_000);
		utimesSync(`${lock}.recovery`, stale, stale);
		expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", taskId: initial.taskId });
		expect(existsSync(lock)).toBe(false);
	}, 15_000);

	it.each([
		["without an owner", undefined],
		["with a partly written owner", '{"pid":'],
	])(
		"recovers an abandoned lock %s",
		(_case, owner) => {
			const initial = beginTask({ cwd: repo });
			const lock = join(repo, ".git", "draht-budgets.lock");
			mkdirSync(lock);
			if (owner !== undefined) writeFileSync(join(lock, "owner"), owner);
			const stale = new Date(Date.now() - 60_000);
			utimesSync(lock, stale, stale);
			expect(auditBudget({ cwd: repo })).toMatchObject({ status: "passed", taskId: initial.taskId });
			expect(existsSync(lock)).toBe(false);
		},
		20_000,
	);

	it("rereads a same-size file changed within the timestamp granularity of the last snapshot", () => {
		configure({ maxCodeTokens: 1 });
		writeFileSync(join(repo, "code.ts"), "aaaa\n");
		beginTask({ cwd: repo });
		const { atime, mtime } = statSync(join(repo, "code.ts"));
		writeFileSync(join(repo, "code.ts"), "bbbb\n");
		utimesSync(join(repo, "code.ts"), atime, mtime);
		expect(auditBudget({ cwd: repo }).status).toBe("failed");
	});

	it("keeps a moved oversized file within its old ceiling", () => {
		configure({ maxFileTokens: 10 });
		writeFileSync(join(repo, "legacy.ts"), "export const value = 123;\n".repeat(20));
		git(repo, "add", "legacy.ts", ".draht/budgets.json");
		git(repo, "commit", "-m", "legacy");
		beginTask({ cwd: repo });
		mkdirSync(join(repo, "lib"));
		git(repo, "mv", "legacy.ts", "lib/legacy.ts");
		writeFileSync(join(repo, "lib", "legacy.ts"), `${readFileSync(join(repo, "lib", "legacy.ts"), "utf8")}x;\n`);
		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens("x;\n") },
		});
	});

	it("counts files under a directory replaced by a file as deleted instead of failing the audit", () => {
		const code = "export const value = 1;\n";
		mkdirSync(join(repo, "lib"));
		writeFileSync(join(repo, "lib", "code.ts"), code);
		beginTask({ cwd: repo });
		rmSync(join(repo, "lib"), { recursive: true });
		writeFileSync(join(repo, "lib"), "replacement\n");
		expect(auditBudget({ cwd: repo })).toMatchObject({
			status: "passed",
			usage: { codeTokens: countTokens(code) + countTokens("replacement\n") },
		});
	});

	it("inspects the requested working tree even when inherited Git variables point to a different repository", () => {
		configure({ maxCodeTokens: 2 });
		const initial = beginTask({ cwd: repo });
		const foreign = join(root, "foreign");
		mkdirSync(foreign);
		git(foreign, "init");
		vi.stubEnv("GIT_DIR", join(foreign, ".git"));
		vi.stubEnv("GIT_WORK_TREE", foreign);
		vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git", "index"));
		writeFileSync(join(repo, "code.ts"), "hello world again\n");
		const report = auditBudget({ cwd: repo });
		expect(report.taskId).toBe(initial.taskId);
		expect(report.status).toBe("failed");
		expect(report.usage.codeTokens).toBe(countTokens("hello world again\n"));
	});

	it("counts text replacing binary content instead of treating the original file as permanently exempt", () => {
		writeFileSync(join(repo, "data.bin"), Buffer.from([0xff, 0x00]));
		beginTask({ cwd: repo });
		writeFileSync(join(repo, "data.bin"), "now contains source text\n");
		expect(auditBudget({ cwd: repo }).usage.codeTokens).toBe(countTokens("now contains source text\n"));
	});

	it("can repair a fragmented rewrite after its bounded diff falls back to whole-file accounting", () => {
		configure({ maxCodeTokens: 100 });
		const before = "before\nunchanged\n".repeat(2050);
		writeFileSync(join(repo, "code.ts"), before);
		beginTask({ cwd: repo });
		writeFileSync(join(repo, "code.ts"), "after\nunchanged\n".repeat(2050));
		const audit = auditBudget({ cwd: repo });
		expect(audit.status).toBe("failed");
		expect(audit.usage.codeTokens).toBe(countTokens(before) + countTokens("after\nunchanged\n".repeat(2050)));
		expect(checkBudget({ cwd: repo, proposed: [{ path: "code.ts", content: before }] })).toMatchObject({
			status: "passed",
			usage: { codeTokens: 0 },
		});
	});
});
