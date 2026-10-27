import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBudget, exceededSummary, worsenedIssues } from "../src/core/budgets/evaluation.ts";
import { excludeMatcher, isAlwaysExcluded, parseExcludes } from "../src/core/budgets/exclusions.ts";
import {
	countTokens,
	DEFAULT_BUDGET_LIMITS,
	type MeasuredTokens,
	measureChange,
	measureTokens,
	parseBudgetLimits,
} from "../src/core/budgets/policy.ts";
import { pairRenames } from "../src/core/budgets/renames.ts";
import {
	type BudgetState,
	budgetContentHash,
	budgetLedger,
	readBudgetState,
	writeBudgetState,
} from "../src/core/budgets/state.ts";

describe("budget token accounting", () => {
	it.each([
		["", 0],
		["hello world", 2],
		["const x = 1;\n", 6],
		["你好世界", 5],
		["🙂", 2],
		["<|endoftext|>", 7],
	])("counts %j as %i ordinary cl100k_base tokens", (text, expected) => {
		expect(countTokens(text)).toBe(expected);
		expect(countTokens(text)).toBe(expected);
	});
});

describe("budget configuration", () => {
	it("fills omitted limits without modifying the defaults", () => {
		expect(parseBudgetLimits({})).toEqual({
			maxFileTokens: 5000,
			maxDocFileTokens: 1500,
			maxCodeTokens: null,
			maxDocTokens: null,
			maxOversizedGrowthTokens: 250,
		});
		expect(parseBudgetLimits({ maxCodeTokens: 30000 })).toEqual({
			maxFileTokens: 5000,
			maxDocFileTokens: 1500,
			maxCodeTokens: 30000,
			maxDocTokens: null,
			maxOversizedGrowthTokens: 250,
		});
		expect(DEFAULT_BUDGET_LIMITS.maxCodeTokens).toBeNull();
	});

	it.each(["maxFileTokens", "maxDocFileTokens", "maxCodeTokens", "maxDocTokens"])(
		"rejects invalid numeric %s",
		(key) => {
			for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, "5000", undefined, true]) {
				expect(() => parseBudgetLimits({ [key]: value })).toThrow(key);
			}
			expect(parseBudgetLimits({ [key]: 1 })).toHaveProperty(key, 1);
			expect(parseBudgetLimits({ [key]: Number.MAX_SAFE_INTEGER })).toHaveProperty(key, Number.MAX_SAFE_INTEGER);
		},
	);

	it("accepts a zero oversized-file growth allowance but no negative or fractional one", () => {
		expect(parseBudgetLimits({ maxOversizedGrowthTokens: 0 }).maxOversizedGrowthTokens).toBe(0);
		for (const value of [-1, 1.5, Number.NaN, "250", null]) {
			expect(() => parseBudgetLimits({ maxOversizedGrowthTokens: value })).toThrow("maxOversizedGrowthTokens");
		}
	});

	it.each(["maxCodeTokens", "maxDocTokens"])("allows disabling the optional %s task cap", (key) => {
		expect(parseBudgetLimits({ [key]: null })).toHaveProperty(key, null);
	});

	it.each(["maxFileTokens", "maxDocFileTokens"])("does not allow disabling the %s file ceiling", (key) => {
		expect(() => parseBudgetLimits({ [key]: null })).toThrow(key);
	});

	it("rejects non-object configuration and unknown keys instead of silently ignoring them", () => {
		for (const value of [null, undefined, [], 5000, "5000", true]) {
			expect(() => parseBudgetLimits(value)).toThrow("object");
		}
		expect(() => parseBudgetLimits({ maxFileToken: 10 })).toThrow("maxFileToken");
		expect(() => parseBudgetLimits({ enabled: false })).toThrow("enabled");
	});
});

describe("task patch measurement", () => {
	const limits = DEFAULT_BUDGET_LIMITS;

	it("charges a replacement for both its added and deleted tokens", () => {
		expect(measureChange({ path: "src/main.ts", before: "hello\n", after: "world\n", limits })).toEqual({
			path: "src/main.ts",
			category: "code",
			addedTokens: 2,
			deletedTokens: 2,
			fileTokens: 2,
			fileCeiling: 5000,
			fileLimitExceeded: false,
		});
	});

	it("excludes unchanged context between changed hunks", () => {
		const change = measureChange({
			path: "src/main.ts",
			before: "hello\nkeep\nhello\n",
			after: "world\nkeep\nworld\n",
			limits,
		});
		expect(change).toMatchObject({ addedTokens: 4, deletedTokens: 4 });
	});

	it("counts the full content of added and deleted files", () => {
		expect(measureChange({ path: "new.ts", before: null, after: "hello\n", limits })).toMatchObject({
			addedTokens: 2,
			deletedTokens: 0,
			fileTokens: 2,
		});
		expect(measureChange({ path: "old.ts", before: "hello\n", after: null, limits })).toMatchObject({
			addedTokens: 0,
			deletedTokens: 2,
			fileTokens: 0,
			fileLimitExceeded: false,
		});
	});

	it("charges no change for an unchanged oversized file", () => {
		const content = "x ".repeat(5000);
		expect(measureChange({ path: "legacy.ts", before: content, after: content, limits })).toMatchObject({
			addedTokens: 0,
			deletedTokens: 0,
			fileTokens: 5001,
			fileLimitExceeded: false,
		});
	});

	it("allows the exact token ceiling and rejects one additional token on a single line", () => {
		expect(measureChange({ path: "minified.js", before: null, after: "x ".repeat(4999), limits })).toMatchObject({
			fileTokens: 5000,
			fileLimitExceeded: false,
		});
		expect(measureChange({ path: "minified.js", before: null, after: "x ".repeat(5000), limits })).toMatchObject({
			fileTokens: 5001,
			fileLimitExceeded: true,
		});
	});

	it("counts a dense 40,000-character line exactly without splitting its BPE pieces", () => {
		expect(measureChange({ path: "dense.js", before: null, after: "a".repeat(40000), limits })).toMatchObject({
			addedTokens: 5000,
			fileTokens: 5000,
			fileLimitExceeded: false,
		});
		expect(measureChange({ path: "dense.js", before: null, after: "a".repeat(40008), limits })).toMatchObject({
			addedTokens: 5001,
			fileTokens: 5001,
			fileLimitExceeded: true,
		});
	});

	it("uses the configured code-file ceiling", () => {
		const smallLimits = { ...limits, maxFileTokens: 1 };
		expect(measureChange({ path: "code.ts", before: null, after: "hello world", limits: smallLimits })).toMatchObject(
			{
				fileTokens: 2,
				fileLimitExceeded: true,
			},
		);
	});

	it("lets oversized baseline files shrink, or grow only by the configured allowance", () => {
		const before = "x ".repeat(6000);
		for (const after of ["x ".repeat(5500), "y ".repeat(6000), "x ".repeat(6250)]) {
			expect(measureChange({ path: "legacy.ts", before, after, limits }).fileLimitExceeded).toBe(false);
		}
		expect(measureChange({ path: "legacy.ts", before, after: "x ".repeat(6251), limits })).toMatchObject({
			fileTokens: 6252,
			fileCeiling: 6251,
			fileLimitExceeded: true,
		});
		const frozen = { ...limits, maxOversizedGrowthTokens: 0 };
		expect(measureChange({ path: "legacy.ts", before, after: "x ".repeat(6001), limits: frozen })).toMatchObject({
			fileCeiling: 6001,
			fileLimitExceeded: true,
		});
	});

	it("charges whole changed lines even when only one word on the line changes", () => {
		const before = "x ".repeat(5000);
		const after = `y ${before.slice(2)}`;
		expect(measureChange({ path: "legacy.js", before, after, limits })).toMatchObject({
			addedTokens: 5001,
			deletedTokens: 5001,
			fileTokens: 5001,
			fileLimitExceeded: false,
		});
	});

	it("charges whole-file replacement when fragmented changes exceed the bounded diff search", () => {
		expect(
			measureChange({
				path: "large.ts",
				before: `${"a\n".repeat(3000)}shared\n`,
				after: `${"b\n".repeat(3000)}shared\n`,
				limits,
			}),
		).toMatchObject({ addedTokens: 6002, deletedTokens: 6002, fileTokens: 6002 });
	});

	it("counts pure additions and deletions without needing a bounded diff search", () => {
		const content = "a\n".repeat(5000);
		expect(measureChange({ path: "large.ts", before: null, after: content, limits })).toMatchObject({
			addedTokens: 10000,
			deletedTokens: 0,
			fileTokens: 10000,
		});
		expect(measureChange({ path: "large.ts", before: content, after: null, limits })).toMatchObject({
			addedTokens: 0,
			deletedTokens: 10000,
			fileTokens: 0,
		});
	});

	it.each(["README.md", "guide.MDX", "api.rst", "notes.txt", "manual.adoc", "intro.markdown", "book.asciidoc"])(
		"applies the documentation ceiling to %s",
		(path) => {
			expect(measureChange({ path, before: null, after: "x ".repeat(1500), limits })).toMatchObject({
				category: "docs",
				addedTokens: 1501,
				fileTokens: 1501,
				fileLimitExceeded: true,
			});
		},
	);

	it("allows the exact documentation ceiling and honors an independent override", () => {
		expect(measureChange({ path: "README.md", before: null, after: "x ".repeat(1499), limits })).toMatchObject({
			fileTokens: 1500,
			fileLimitExceeded: false,
		});
		expect(
			measureChange({
				path: "README.md",
				before: null,
				after: "hello world",
				limits: { ...limits, maxDocFileTokens: 1 },
			}).fileLimitExceeded,
		).toBe(true);
	});

	it("lets existing oversized documentation remain, shrink, or grow within the allowance", () => {
		const before = "x ".repeat(2000);
		for (const after of [before, "y ".repeat(2000), "x ".repeat(1700), "x ".repeat(2250)]) {
			expect(measureChange({ path: "manual.md", before, after, limits }).fileLimitExceeded).toBe(false);
		}
		expect(measureChange({ path: "manual.md", before, after: "x ".repeat(2251), limits })).toMatchObject({
			fileTokens: 2252,
			fileCeiling: 2251,
			fileLimitExceeded: true,
		});
	});

	it.each([
		"src/main.ts",
		"test/main.test.ts",
		"settings.json",
		"LICENSE",
		"docs.md/example.py",
		"guide.md\n",
		"CMakeLists.txt",
		"tools/requirements-dev.txt",
		"constraints.txt",
	])("charges other text %s to code", (path) => {
		expect(measureChange({ path, before: null, after: "hello", limits }).category).toBe("code");
	});
});

describe("budget reporting and persisted limits", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});
	const state = (): BudgetState => ({
		version: 2,
		taskId: "task",
		limits: { ...DEFAULT_BUDGET_LIMITS },
		exclude: [],
		worktrees: [],
	});
	const manual = (removed = false) => {
		const before = "x ".repeat(2000);
		const after = "x ".repeat(2252);
		const budget = state();
		budget.worktrees = [
			{
				root: "/repo",
				attributes: null,
				removed,
				baseline: { "manual.md": budgetContentHash(before) },
				current: { "manual.md": budgetContentHash(after) },
			},
		];
		const projected = new Map([
			[budgetContentHash(before), before],
			[budgetContentHash(after), after],
		]);
		return { budget, projected };
	};

	it("leads with per-file ceilings and shows only configured task limits", () => {
		const budget = state();
		const summary = evaluateBudget("unused", budget).report.summary;
		expect(summary).toContain("code files <= 5000 tokens");
		expect(summary).toContain("documentation files <= 1500 tokens");
		expect(summary).not.toContain("changed tokens");
		expect(summary).not.toContain("null");
		budget.limits.maxDocTokens = 700;
		const cappedSummary = evaluateBudget("unused", budget).report.summary;
		expect(cappedSummary).toContain("documentation 0/700 changed tokens");
		expect(cappedSummary.indexOf("documentation files")).toBeLessThan(cappedSummary.indexOf("0/700"));
		expect(cappedSummary).not.toContain("code 0/");
	});

	it("reports the documentation file ceiling and the excess beyond the growth allowance", () => {
		const { budget, projected } = manual();
		const result = evaluateBudget("unused", budget, { projected });
		expect(result.report.violations).toEqual(["manual.md: 2253 documentation tokens exceed file ceiling 2251"]);
		expect(result.issues).toEqual([
			{
				key: JSON.stringify(["/repo", "manual.md"]),
				excess: 2,
				message: "manual.md: 2253 documentation tokens exceed file ceiling 2251",
			},
		]);
		const named = evaluateBudget("unused", budget, { projected, currentRoot: "/other" });
		expect(named.report.violations).toEqual([
			"manual.md in worktree /repo: 2253 documentation tokens exceed file ceiling 2251",
		]);
	});

	it("keeps a removed worktree's usage but drops its file ceilings, which nobody can repair", () => {
		const { budget, projected } = manual(true);
		const result = evaluateBudget("unused", budget, { projected });
		expect(result.report.status).toBe("passed");
		expect(result.report.usage.docTokens).toBe(countTokens("x ".repeat(2000)) + countTokens("x ".repeat(2252)));
	});

	it("blocks only changes that add to an excess", () => {
		const issue = (key: string, excess: number) => ({ key, excess, message: key });
		const evaluation = (...issues: ReturnType<typeof issue>[]) => ({ issues });
		const current = evaluation(issue("a", 5), issue("code", 3));
		expect(worsenedIssues(current, evaluation(issue("a", 5), issue("code", 3)))).toEqual([]);
		expect(worsenedIssues(current, evaluation(issue("a", 4)))).toEqual([]);
		expect(worsenedIssues(current, evaluation(issue("a", 6)))).toEqual([issue("a", 6)]);
		expect(worsenedIssues(current, evaluation(issue("a", 5), issue("b", 1)))).toEqual([issue("b", 1)]);
	});

	it("uses cached measurements instead of measuring a known change again", () => {
		const before = "x ".repeat(2000);
		const after = "x ".repeat(2001);
		const { budget } = manual();
		budget.worktrees[0].current = { "manual.md": budgetContentHash(after) };
		const key = `${budgetContentHash(before)}:${budgetContentHash(after)}`;
		const cached: MeasuredTokens = { addedTokens: 7, deletedTokens: 3, fileTokens: 9999, baselineTokens: 2001 };
		const result = evaluateBudget("unused", budget, { measures: new Map([[key, cached]]) });
		expect(result.measured).toBe(false);
		expect(result.report.usage.docTokens).toBe(10);
		expect(result.report.violations).toEqual(["manual.md: 9999 documentation tokens exceed file ceiling 2251"]);
		expect([...result.measures.keys()]).toEqual([key]);
	});

	it("measures a moved oversized file against its old content", () => {
		const before = "export const value = 1;\n".repeat(900);
		const after = `${before}export const moved = 2;\n`;
		expect(countTokens(before)).toBeGreaterThan(DEFAULT_BUDGET_LIMITS.maxFileTokens);
		const budget = state();
		budget.worktrees = [
			{
				root: "/repo",
				attributes: null,
				removed: false,
				baseline: { "old/legacy.ts": budgetContentHash(before) },
				current: { "new/legacy.ts": budgetContentHash(after) },
			},
		];
		const projected = new Map([
			[budgetContentHash(before), before],
			[budgetContentHash(after), after],
		]);
		const result = evaluateBudget("unused", budget, { projected });
		expect(result.report.status).toBe("passed");
		expect(result.report.usage.codeTokens).toBe(
			measureTokens(before, after).addedTokens + measureTokens(before, after).deletedTokens,
		);
	});

	it("names at most ten violations in a summary", () => {
		const messages = Array.from({ length: 12 }, (_, index) => `file-${index}`);
		const summary = exceededSummary(messages);
		expect(summary).toContain("file-9");
		expect(summary).not.toContain("file-10");
		expect(summary).toMatch(/and 2 more$/);
	});

	it("requires every persisted limit and a matching task marker", () => {
		const directory = mkdtempSync(join(tmpdir(), "budget-policy-"));
		directories.push(directory);
		const ledger = budgetLedger(directory);
		const budget = state();
		writeBudgetState(ledger, budget);
		expect(() => readBudgetState(ledger)).toThrow("incomplete");
		writeFileSync(ledger.marker, budget.taskId);
		expect(readBudgetState(ledger)?.limits).toEqual(DEFAULT_BUDGET_LIMITS);
		writeFileSync(ledger.marker, "another task");
		expect(() => readBudgetState(ledger)).toThrow("does not match");
		writeFileSync(ledger.marker, budget.taskId);
		const { maxDocFileTokens: _omitted, ...incomplete } = budget.limits;
		writeFileSync(join(ledger.directory, "task.json"), JSON.stringify({ ...budget, limits: incomplete }));
		expect(() => readBudgetState(ledger)).toThrow("Invalid budget task ledger");
	});
});

describe("budget exclusions", () => {
	it.each([
		"bun.lock",
		"packages/app/package-lock.json",
		"go/go.sum",
		"Cargo.lock",
		"CHANGELOG.md",
		"packages/ai/changelog.md",
		".env",
		"apps/web/.env.local",
		"config/.npmrc",
		"certs/server.pem",
		"keys/id_ed25519",
	])("always skips %s", (path) => {
		expect(isAlwaysExcluded(path)).toBe(true);
	});

	it.each(["src/lock.ts", "CHANGELOG.mdx", "docs/changelog-guide.md", "package.json", "src/env.ts", "docs/pem.md"])(
		"measures %s",
		(path) => {
			expect(isAlwaysExcluded(path)).toBe(false);
		},
	);

	it("anchors patterns with a slash at the repository root and matches bare names at any depth", () => {
		const matches = excludeMatcher(["*.generated.ts", "packages/*/dist/**", "vendor/", "/docs/api.md", "a/**/b.ts"]);
		for (const path of [
			"src/models.generated.ts",
			"models.generated.ts",
			"packages/ai/dist/index.js",
			"vendor/lib.js",
			"packages/x/vendor/lib.js",
			"docs/api.md",
			"a/b.ts",
			"a/x/y/b.ts",
		]) {
			expect(matches(path), path).toBe(true);
		}
		for (const path of [
			"src/models.ts",
			"packages/ai/src/dist/index.js",
			"packages/ai/dist",
			"vendored.js",
			"guide/docs/api.md",
			"b/a/b.ts.map",
		]) {
			expect(matches(path), path).toBe(false);
		}
	});

	it("rejects patterns it cannot honor", () => {
		expect(parseExcludes(["dist/"])).toEqual(["dist/"]);
		for (const value of ["dist/", 5, null, {}]) expect(() => parseExcludes(value)).toThrow("array");
		for (const pattern of ["", "  ", "!keep.ts", 7])
			expect(() => parseExcludes([pattern])).toThrow("exclude pattern");
	});
});

describe("budget rename detection", () => {
	const tokens = (text: string) => measureTokens(null, text);
	const contents = new Map<string, string>();
	const hash = (text: string) => {
		const value = budgetContentHash(text);
		contents.set(value, text);
		return value;
	};
	const measure = (beforeHash: string, afterHash: string) =>
		measureTokens(contents.get(beforeHash) ?? null, contents.get(afterHash) ?? null);
	const body = "export const value = 1;\n".repeat(40);

	it("pairs identical content first, then the most similar remaining file", () => {
		const edited = `${body}export const extra = 2;\n`;
		const pairs = pairRenames(
			[
				["a.ts", hash(body)],
				["b.ts", hash(edited)],
			],
			[
				["moved/b.ts", hash(edited)],
				["moved/a.ts", hash(`${body}export const other = 3;\n`)],
			],
			measure,
		);
		expect(pairs).toEqual(
			new Map([
				["moved/b.ts", "b.ts"],
				["moved/a.ts", "a.ts"],
			]),
		);
	});

	it("leaves unrelated files unpaired", () => {
		const pairs = pairRenames(
			[["old.ts", hash(body)]],
			[["new.md", hash("Completely different prose.\n".repeat(30))]],
			measure,
		);
		expect(pairs.size).toBe(0);
		expect(tokens(body).fileTokens).toBeGreaterThan(0);
	});

	it("compares an edited move with the deleted file sharing most of its path first", () => {
		const deleted: Array<[string, string]> = [];
		const added: Array<[string, string]> = [];
		for (let index = 0; index < 12; index++) {
			const content = `${body}export const feature${index} = ${index};\n`;
			deleted.push([`src/feature${index}/index.ts`, hash(content)]);
			added.push([`lib/feature${index}/index.ts`, hash(`${content}export const moved = true;\n`)]);
		}
		let comparisons = 0;
		const pairs = pairRenames(deleted, added, (before, after) => {
			comparisons++;
			return measure(before, after);
		});
		expect([...pairs]).toEqual(added.map(([path], index) => [path, deleted[index][0]]));
		expect(comparisons).toBe(12);
	});

	it("prefers a near-identical source over a less similar one that shares the destination's name", () => {
		const lines = Array.from({ length: 30 }, (_, line) => `export const value${line} = ${line};\n`);
		const source = lines.join("");
		const other = Array.from({ length: 10 }, (_, line) => `export const other${line} = ${line};\n`);
		const related = [...lines.slice(0, 20), ...other].join("");
		const destination = `${source}export const extra = true;\n`;
		const sameName = measureTokens(related, destination);
		expect(
			1 - (sameName.addedTokens + sameName.deletedTokens) / (sameName.baselineTokens + sameName.fileTokens),
		).toBeGreaterThan(0.5);
		const pairs = pairRenames(
			[
				["a/index.ts", hash(related)],
				["a/main.ts", hash(source)],
			],
			[["b/index.ts", hash(destination)]],
			measure,
		);
		expect(pairs).toEqual(new Map([["b/index.ts", "a/main.ts"]]));
	});

	it("spends its comparison limit only on new measurements, so cached ones let a large batch pair fully", () => {
		const deleted: Array<[string, string]> = [];
		const added: Array<[string, string]> = [];
		for (let index = 0; index < 9; index++) {
			const content = Array.from(
				{ length: 30 },
				(_, line) => `export const value${index}x${line} = ${line};\n`,
			).join("");
			deleted.push([`old/source${index}.ts`, hash(content)]);
			// Reversed, so each moved file finds its source last among the remaining candidates.
			added.unshift([`new/target${index}.ts`, hash(`${content}export const extra = ${index};\n`)]);
		}
		const cache = new Map<string, MeasuredTokens>();
		const cached = (before: string, after: string) => cache.has(`${before}:${after}`);
		const caching = (before: string, after: string) => {
			const value = cache.get(`${before}:${after}`) ?? measure(before, after);
			cache.set(`${before}:${after}`, value);
			return value;
		};
		expect(pairRenames(deleted, added, caching, cached).size).toBeLessThan(9);
		expect([...pairRenames(deleted, added, caching, cached)]).toEqual(
			added.map(([path]) => [path, path.replace("new/target", "old/source")]),
		);
	});
});
