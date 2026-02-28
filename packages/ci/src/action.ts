/**
 * GitHub Action entry point for Draht AI Review.
 * Orchestrates: fetch diff → review with Claude → post comments → set status.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type PRContext, createOctokit, getPRDiff, postReviewComments, setCheckStatus } from "./github.js";
import { type Finding, reviewDiff } from "./reviewer.js";

type Severity = "info" | "warning" | "critical";

async function main(): Promise<void> {
	// Read inputs
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
	const githubToken = process.env.GITHUB_TOKEN;
	const model = process.env.INPUT_MODEL ?? "claude-sonnet-4-20250514";
	const agentsMdPath = process.env.INPUT_AGENTS_MD_PATH ?? "AGENTS.md";
	const severityThreshold = (process.env.INPUT_SEVERITY_THRESHOLD ?? "critical") as Severity;
	const maxFiles = Number.parseInt(process.env.INPUT_MAX_FILES ?? "0", 10);

	if (!anthropicApiKey) {
		console.error("❌ ANTHROPIC_API_KEY is required");
		process.exit(1);
	}
	if (!githubToken) {
		console.error("❌ GITHUB_TOKEN is required");
		process.exit(1);
	}

	// Parse PR event
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		console.error("❌ GITHUB_EVENT_PATH not set — are you running in a GitHub Action?");
		process.exit(1);
	}

	const event = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
	const pr = event.pull_request;
	if (!pr) {
		console.error("❌ No pull_request in event payload");
		process.exit(1);
	}

	const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
	const ctx: PRContext = {
		owner,
		repo,
		prNumber: pr.number,
		sha: pr.head.sha,
	};

	console.log(`🔍 Reviewing PR #${ctx.prNumber} in ${ctx.owner}/${ctx.repo}`);

	const octokit = createOctokit(githubToken);

	// Fetch diff
	console.log("📥 Fetching PR diff...");
	let diff = await getPRDiff(octokit, ctx);

	// Truncate if too large (Claude context limits)
	if (diff.length > 100_000) {
		console.log(`⚠️ Diff truncated from ${diff.length} to 100000 chars`);
		diff = diff.slice(0, 100_000);
	}

	// Read AGENTS.md
	let agentsMdContent: string | null = null;
	const workspace = process.env.GITHUB_WORKSPACE ?? ".";
	const agentsFullPath = path.join(workspace, agentsMdPath);
	if (fs.existsSync(agentsFullPath)) {
		agentsMdContent = fs.readFileSync(agentsFullPath, "utf-8");
		console.log(`📋 Loaded AGENTS.md from ${agentsMdPath}`);
	} else {
		console.log(`ℹ️ No AGENTS.md found at ${agentsMdPath}, reviewing without project conventions`);
	}

	// Review
	console.log(`🤖 Sending to Claude (${model})...`);
	const findings = await reviewDiff(diff, agentsMdContent, model, anthropicApiKey);
	console.log(`📝 Found ${findings.length} issues`);

	// Post comments
	if (findings.length > 0) {
		console.log("💬 Posting review comments...");
		try {
			await postReviewComments(
				octokit,
				ctx,
				findings.map((f) => ({
					path: f.path,
					line: f.line,
					body: f.suggestion ? `${f.message}\n\n**Suggestion:** ${f.suggestion}` : f.message,
					severity: f.severity,
				})),
			);
		} catch (error) {
			console.warn(`⚠️ Failed to post some comments: ${error instanceof Error ? error.message : error}`);
		}
	}

	// Determine status
	const severityOrder: Severity[] = ["info", "warning", "critical"];
	const thresholdIndex = severityOrder.indexOf(severityThreshold);
	const hasBlockingFindings = findings.some((f) => severityOrder.indexOf(f.severity) >= thresholdIndex);

	const criticalCount = findings.filter((f) => f.severity === "critical").length;
	const warningCount = findings.filter((f) => f.severity === "warning").length;
	const infoCount = findings.filter((f) => f.severity === "info").length;

	const summary = `AI Review: ${criticalCount} critical, ${warningCount} warnings, ${infoCount} info`;

	// Set check status
	await setCheckStatus(octokit, ctx, hasBlockingFindings ? "failure" : "success", summary);

	// Write step summary
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) {
		const md = [
			"## 🤖 Draht AI Review",
			"",
			`| Severity | Count |`,
			`|----------|-------|`,
			`| 🔴 Critical | ${criticalCount} |`,
			`| 🟡 Warning | ${warningCount} |`,
			`| 🔵 Info | ${infoCount} |`,
			"",
			hasBlockingFindings ? `❌ **Merge blocked** — findings at or above \`${severityThreshold}\` threshold` : "✅ **All clear** — no blocking findings",
		].join("\n");
		fs.appendFileSync(summaryFile, md);
	}

	// Set outputs
	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		fs.appendFileSync(outputFile, `findings-count=${findings.length}\n`);
		fs.appendFileSync(outputFile, `critical-count=${criticalCount}\n`);
		fs.appendFileSync(outputFile, `review-summary=${summary}\n`);
	}

	console.log(`\n${hasBlockingFindings ? "❌" : "✅"} ${summary}`);

	if (hasBlockingFindings) {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("❌ Action failed:", error);
	process.exit(1);
});
