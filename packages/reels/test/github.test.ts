import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhRunner } from "../src/github.ts";
import { createGithubLookup, parseGithubRepo } from "../src/github.ts";

const SHA_WITH_PR = "a".repeat(40);
const SHA_WITHOUT_PR = "b".repeat(40);

function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
	const dir = mkdtempSync(join(tmpdir(), "reels-github-test-"));
	try {
		const result = fn(dir);
		if (result instanceof Promise) {
			return result.finally(() => rmSync(dir, { recursive: true, force: true }));
		}
		rmSync(dir, { recursive: true, force: true });
		return result;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

const PR_RESPONSE = [
	{
		number: 42,
		html_url: "https://github.com/acme/widget/pull/42",
		title: "Add the widget",
		body: "Because widgets are nice.",
		merged_at: "2026-01-01T00:00:00Z",
		user: { login: "octocat" },
		labels: [{ name: "feature" }],
	},
];

function recordingGh(responses: Record<string, string>, calls: string[][]): GhRunner {
	return async (args) => {
		calls.push(args);
		const path = args[args.length - 1];
		const response = responses[path];
		if (response === undefined) throw new Error(`unexpected gh call: ${path}`);
		return response;
	};
}

describe("parseGithubRepo", () => {
	test("accepts https form", () => {
		expect(parseGithubRepo("https://github.com/draht-dev/draht.git")).toBe("draht-dev/draht");
		expect(parseGithubRepo("https://github.com/draht-dev/draht")).toBe("draht-dev/draht");
	});

	test("accepts scp-like ssh form", () => {
		expect(parseGithubRepo("git@github.com:draht-dev/draht.git")).toBe("draht-dev/draht");
	});

	test("accepts ssh:// form", () => {
		expect(parseGithubRepo("ssh://git@github.com/draht-dev/draht.git")).toBe("draht-dev/draht");
	});

	test("rejects a lookalike host embedding github.com in the path", () => {
		expect(parseGithubRepo("https://evil.com/github.com/a/b")).toBeUndefined();
		expect(parseGithubRepo("evil.com/github.com/a/b")).toBeUndefined();
	});

	test("rejects a non-github host", () => {
		expect(parseGithubRepo("https://gitlab.com/a/b")).toBeUndefined();
		expect(parseGithubRepo("https://github.com.evil.com/a/b")).toBeUndefined();
	});
});

describe("createGithubLookup", () => {
	test("finds a PR by sha", async () => {
		await withTmpDir(async (cacheDir) => {
			const calls: string[][] = [];
			const gh = recordingGh(
				{
					[`repos/acme/widget/commits/${SHA_WITH_PR}/pulls`]: JSON.stringify(PR_RESPONSE),
					"repos/acme/widget/pulls/42/reviews": JSON.stringify([
						{ user: { login: "reviewer" }, state: "APPROVED", body: "lgtm" },
					]),
					"repos/acme/widget/pulls/42/comments": JSON.stringify([
						{ user: { login: "reviewer" }, path: "src/widget.ts", body: "nit" },
					]),
				},
				calls,
			);
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			const pr = await lookup.lookupPullRequestForSha(SHA_WITH_PR);
			expect(pr).toBeDefined();
			expect(pr?.number).toBe(42);
			expect(pr?.url).toBe("https://github.com/acme/widget/pull/42");
			expect(pr?.author).toBe("octocat");
			expect(pr?.mergedAt).toBe("2026-01-01T00:00:00Z");
			expect(pr?.labels).toEqual(["feature"]);
			expect(pr?.reviews).toEqual([{ author: "reviewer", state: "APPROVED", body: "lgtm" }]);
			expect(pr?.comments).toEqual([{ author: "reviewer", path: "src/widget.ts", body: "nit" }]);
		});
	});

	test("returns undefined when no PR is found", async () => {
		await withTmpDir(async (cacheDir) => {
			const calls: string[][] = [];
			const gh = recordingGh({ [`repos/acme/widget/commits/${SHA_WITHOUT_PR}/pulls`]: "[]" }, calls);
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			const pr = await lookup.lookupPullRequestForSha(SHA_WITHOUT_PR);
			expect(pr).toBeUndefined();
		});
	});

	test("gh ENOENT returns undefined and warns exactly once per run", async () => {
		await withTmpDir(async (cacheDir) => {
			const warnings: string[] = [];
			const gh: GhRunner = async () => {
				const error = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			};
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh, warn: (m) => warnings.push(m) });
			const first = await lookup.lookupPullRequestForSha(SHA_WITH_PR);
			const second = await lookup.lookupPullRequestForSha(SHA_WITHOUT_PR);
			expect(first).toBeUndefined();
			expect(second).toBeUndefined();
			expect(warnings).toHaveLength(1);
		});
	});

	test("a non-zero exit (e.g. 403 rate limit) returns undefined with a warning, never throws", async () => {
		await withTmpDir(async (cacheDir) => {
			const warnings: string[] = [];
			const gh: GhRunner = async () => {
				const error = new Error("gh: HTTP 403: API rate limit exceeded") as NodeJS.ErrnoException;
				error.code = "1";
				throw error;
			};
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh, warn: (m) => warnings.push(m) });
			const pr = await lookup.lookupPullRequestForSha(SHA_WITH_PR);
			expect(pr).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("403");
		});
	});

	test("caps bodies at 16 KB", async () => {
		await withTmpDir(async (cacheDir) => {
			const hugeBody = "x".repeat(20 * 1024);
			const calls: string[][] = [];
			const gh = recordingGh(
				{
					[`repos/acme/widget/commits/${SHA_WITH_PR}/pulls`]: JSON.stringify([
						{ ...PR_RESPONSE[0], body: hugeBody },
					]),
					"repos/acme/widget/pulls/42/reviews": "[]",
					"repos/acme/widget/pulls/42/comments": "[]",
				},
				calls,
			);
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			const pr = await lookup.lookupPullRequestForSha(SHA_WITH_PR);
			expect(Buffer.byteLength(pr?.body ?? "", "utf-8")).toBeLessThanOrEqual(16 * 1024 + 3);
			expect(pr?.body.length).toBeLessThan(hugeBody.length);
		});
	});

	test("writes the cache file, and a later lookup reads it without calling gh again", async () => {
		await withTmpDir(async (cacheDir) => {
			const calls: string[][] = [];
			const gh = recordingGh(
				{
					[`repos/acme/widget/commits/${SHA_WITH_PR}/pulls`]: JSON.stringify(PR_RESPONSE),
					"repos/acme/widget/pulls/42/reviews": "[]",
					"repos/acme/widget/pulls/42/comments": "[]",
				},
				calls,
			);
			const first = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			await first.lookupPullRequestForSha(SHA_WITH_PR);
			const callsAfterFirst = calls.length;
			expect(callsAfterFirst).toBeGreaterThan(0);

			const cacheRaw = readFileSync(join(cacheDir, "github.json"), "utf-8");
			const cached = JSON.parse(cacheRaw);
			expect(cached[SHA_WITH_PR].number).toBe(42);

			const throwingGh: GhRunner = async () => {
				throw new Error("gh must not be called again");
			};
			const second = createGithubLookup({ repo: "acme/widget", cacheDir, gh: throwingGh });
			const pr = await second.lookupPullRequestForSha(SHA_WITH_PR);
			expect(pr?.number).toBe(42);
		});
	});

	test("caches a miss too, so a sha without a PR is not re-queried", async () => {
		await withTmpDir(async (cacheDir) => {
			const calls: string[][] = [];
			const gh = recordingGh({ [`repos/acme/widget/commits/${SHA_WITHOUT_PR}/pulls`]: "[]" }, calls);
			const first = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			await first.lookupPullRequestForSha(SHA_WITHOUT_PR);

			const throwingGh: GhRunner = async () => {
				throw new Error("gh must not be called again");
			};
			const second = createGithubLookup({ repo: "acme/widget", cacheDir, gh: throwingGh });
			const pr = await second.lookupPullRequestForSha(SHA_WITHOUT_PR);
			expect(pr).toBeUndefined();
		});
	});

	test("never puts a token in argv", async () => {
		await withTmpDir(async (cacheDir) => {
			const calls: string[][] = [];
			const gh = recordingGh(
				{
					[`repos/acme/widget/commits/${SHA_WITH_PR}/pulls`]: JSON.stringify(PR_RESPONSE),
					"repos/acme/widget/pulls/42/reviews": "[]",
					"repos/acme/widget/pulls/42/comments": "[]",
				},
				calls,
			);
			const lookup = createGithubLookup({ repo: "acme/widget", cacheDir, gh });
			await lookup.lookupPullRequestForSha(SHA_WITH_PR);
			for (const args of calls) {
				for (const arg of args) {
					expect(arg.toLowerCase()).not.toContain("token");
					expect(arg).not.toContain("ghp_");
				}
			}
		});
	});
});
