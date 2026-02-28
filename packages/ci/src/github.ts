/**
 * GitHub API helpers for PR review pipeline.
 */

import { Octokit } from "@octokit/rest";

export interface ReviewComment {
	path: string;
	line: number;
	body: string;
	severity: "info" | "warning" | "critical";
}

export interface PRContext {
	owner: string;
	repo: string;
	prNumber: number;
	sha: string;
}

export function createOctokit(token: string): Octokit {
	return new Octokit({ auth: token });
}

/**
 * Fetch the diff for a pull request.
 */
export async function getPRDiff(octokit: Octokit, ctx: PRContext): Promise<string> {
	const { data } = await octokit.pulls.get({
		owner: ctx.owner,
		repo: ctx.repo,
		pull_number: ctx.prNumber,
		mediaType: { format: "diff" },
	});
	return data as unknown as string;
}

/**
 * Post inline review comments on a PR.
 */
export async function postReviewComments(
	octokit: Octokit,
	ctx: PRContext,
	comments: ReviewComment[],
): Promise<void> {
	if (comments.length === 0) return;

	const reviewComments = comments.map((c) => ({
		path: c.path,
		line: c.line,
		body: formatCommentBody(c),
	}));

	await octokit.pulls.createReview({
		owner: ctx.owner,
		repo: ctx.repo,
		pull_number: ctx.prNumber,
		commit_id: ctx.sha,
		event: "COMMENT",
		comments: reviewComments,
	});
}

/**
 * Set commit check status.
 */
export async function setCheckStatus(
	octokit: Octokit,
	ctx: PRContext,
	status: "success" | "failure",
	summary: string,
): Promise<void> {
	await octokit.repos.createCommitStatus({
		owner: ctx.owner,
		repo: ctx.repo,
		sha: ctx.sha,
		state: status,
		description: summary.slice(0, 140),
		context: "draht/ai-review",
	});
}

function formatCommentBody(comment: ReviewComment): string {
	const icon = comment.severity === "critical" ? "🔴" : comment.severity === "warning" ? "🟡" : "🔵";
	return `${icon} **${comment.severity.toUpperCase()}**\n\n${comment.body}`;
}
