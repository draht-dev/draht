/**
 * Optional GitHub PR lookup via the `gh` CLI, keyed by commit sha.
 *
 * PRs are looked up by sha (`gh api repos/{owner}/{repo}/commits/{sha}/pulls`),
 * never by `#N` parsed from a merge subject: most `#N` in draht-mono's history
 * (inherited `Merge pull request #N` subjects) belong to the upstream fork
 * (`badlogic/pi-mono`), not `draht-dev/draht`.
 *
 * `gh` is never required. When it is missing, unauthenticated, or rate
 * limited, a lookup resolves to `undefined` and the run warns instead of
 * throwing, so the pipeline continues with git-only sources. Auth stays with
 * `gh` itself (`GH_TOKEN` / `GITHUB_TOKEN` from the environment); this module
 * never reads, constructs, or passes a token, and no argv ever carries one.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertValidSha } from "./collect.ts";
import type { PullRequestInfo } from "./contract.ts";

const execFileAsync = promisify(execFile);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REVIEWS = 30;
const MAX_COMMENTS = 30;
const CACHE_FILE_NAME = "github.json";

const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = async (args) => {
	const { stdout } = await execFileAsync("gh", args, { maxBuffer: 1024 * 1024 * 16 });
	return stdout;
};

/**
 * owner/repo from a git remote URL. Accepts `github.com[:/]owner/repo(.git)?`
 * in https or ssh form, with or without a `ssh://` scheme. Rejects lookalike
 * hosts (`evil.com/github.com/a/b`, `github.com.evil.com`) and non-GitHub
 * hosts, since only the literal `github.com` host authorizes a lookup.
 */
export function parseGithubRepo(remoteUrl: string): string | undefined {
	const url = remoteUrl.trim();
	const scp = url.match(/^git@github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
	const ssh = url.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
	const https = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
	const match = scp ?? ssh ?? https;
	if (!match) return undefined;
	const ownerRepo = match[1];
	return GITHUB_OWNER_REPO_RE.test(ownerRepo) ? ownerRepo : undefined;
}

function capBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	return `${Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8")}…`;
}

type GithubCache = Record<string, PullRequestInfo | null>;

function cachePath(cacheDir: string): string {
	return join(cacheDir, CACHE_FILE_NAME);
}

async function readGithubCache(cacheDir: string): Promise<GithubCache> {
	let raw: string;
	try {
		raw = await readFile(cachePath(cacheDir), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as GithubCache) : {};
	} catch {
		return {};
	}
}

async function writeGithubCache(cacheDir: string, cache: GithubCache): Promise<void> {
	await mkdir(cacheDir, { recursive: true });
	const path = cachePath(cacheDir);
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, `${JSON.stringify(cache, null, "\t")}\n`);
	await rename(tmpPath, path);
}

interface RawPull {
	number: number;
	html_url: string;
	title?: string | null;
	body?: string | null;
	merged_at?: string | null;
	user?: { login?: string | null } | null;
	labels?: Array<{ name: string }> | null;
}

interface RawReview {
	user?: { login?: string | null } | null;
	state?: string | null;
	body?: string | null;
}

interface RawComment {
	user?: { login?: string | null } | null;
	path?: string | null;
	body?: string | null;
}

async function ghJson<T>(gh: GhRunner, args: string[]): Promise<T> {
	const out = await gh(args);
	return JSON.parse(out) as T;
}

function apiArgs(path: string): string[] {
	return ["api", "--paginate", "-H", "Accept: application/vnd.github+json", path];
}

async function fetchReviews(gh: GhRunner, repo: string, number: number): Promise<PullRequestInfo["reviews"]> {
	const raw = await ghJson<RawReview[]>(gh, apiArgs(`repos/${repo}/pulls/${number}/reviews`));
	return (Array.isArray(raw) ? raw : []).slice(0, MAX_REVIEWS).map((review) => ({
		author: review.user?.login ?? "unknown",
		state: review.state ?? "unknown",
		body: capBytes(review.body ?? "", MAX_BODY_BYTES),
	}));
}

async function fetchComments(gh: GhRunner, repo: string, number: number): Promise<PullRequestInfo["comments"]> {
	const raw = await ghJson<RawComment[]>(gh, apiArgs(`repos/${repo}/pulls/${number}/comments`));
	return (Array.isArray(raw) ? raw : []).slice(0, MAX_COMMENTS).map((comment) => ({
		author: comment.user?.login ?? "unknown",
		path: comment.path ?? undefined,
		body: capBytes(comment.body ?? "", MAX_BODY_BYTES),
	}));
}

async function fetchPullRequestForSha(gh: GhRunner, repo: string, sha: string): Promise<PullRequestInfo | undefined> {
	const pulls = await ghJson<RawPull[]>(gh, apiArgs(`repos/${repo}/commits/${sha}/pulls`));
	if (!Array.isArray(pulls) || pulls.length === 0) return undefined;
	const pr = pulls[0];
	const [reviews, comments] = await Promise.all([
		fetchReviews(gh, repo, pr.number),
		fetchComments(gh, repo, pr.number),
	]);
	return {
		number: pr.number,
		url: pr.html_url,
		title: capBytes(pr.title ?? "", MAX_BODY_BYTES),
		body: capBytes(pr.body ?? "", MAX_BODY_BYTES),
		author: pr.user?.login ?? "unknown",
		mergedAt: pr.merged_at ?? undefined,
		labels: (pr.labels ?? []).map((label) => label.name),
		reviews,
		comments,
	};
}

export interface GithubLookupOptions {
	/** `owner/repo`, e.g. from {@link parseGithubRepo}. */
	repo: string;
	/** Directory holding the cache file; caller passes the output's state/cache dir. */
	cacheDir: string;
	gh?: GhRunner;
	warn?: (message: string) => void;
}

export interface GithubLookup {
	lookupPullRequestForSha(sha: string): Promise<PullRequestInfo | undefined>;
}

/**
 * Builds a lookup client for one run. The `gh`-missing warning fires at most
 * once per client (i.e. once per run); other failures (rate limits, bad
 * responses) warn on every affected sha but never throw.
 */
export function createGithubLookup(options: GithubLookupOptions): GithubLookup {
	if (!GITHUB_OWNER_REPO_RE.test(options.repo)) {
		throw new Error(`refusing to use "${options.repo}" as a GitHub repo: expected "owner/repo"`);
	}
	const gh = options.gh ?? runGh;
	const warn = options.warn ?? ((message: string) => console.warn(message));
	let warnedMissing = false;
	let cache: GithubCache | undefined;

	async function loadCache(): Promise<GithubCache> {
		if (!cache) cache = await readGithubCache(options.cacheDir);
		return cache;
	}

	async function lookupPullRequestForSha(shaInput: string): Promise<PullRequestInfo | undefined> {
		const sha = assertValidSha(shaInput);
		const loaded = await loadCache();
		if (sha in loaded) return loaded[sha] ?? undefined;

		let result: PullRequestInfo | undefined;
		try {
			result = await fetchPullRequestForSha(gh, options.repo, sha);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				if (!warnedMissing) {
					warnedMissing = true;
					warn("draht-reels: gh CLI not found; GitHub PR lookup disabled for this run");
				}
				return undefined;
			}
			warn(`draht-reels: GitHub PR lookup failed for ${sha.slice(0, 12)}: ${err.message ?? String(error)}`);
			return undefined;
		}

		cache = { ...loaded, [sha]: result ?? null };
		await writeGithubCache(options.cacheDir, cache);
		return result;
	}

	return { lookupPullRequestForSha };
}
