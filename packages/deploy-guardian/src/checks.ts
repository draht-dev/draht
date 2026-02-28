/**
 * Pre-deployment check runners.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type CheckSeverity = "pass" | "warning" | "fail";

export interface CheckResult {
	name: string;
	severity: CheckSeverity;
	message: string;
	details?: string;
}

/**
 * Run all pre-deployment checks for the given directory.
 */
export function runPreDeployChecks(cwd: string): CheckResult[] {
	const results: CheckResult[] = [];

	results.push(checkGitStatus(cwd));
	results.push(checkBuildArtifacts(cwd));
	results.push(checkTypeErrors(cwd));
	results.push(checkSSTSafety(cwd));
	results.push(checkEnvFiles(cwd));

	return results;
}

function checkGitStatus(cwd: string): CheckResult {
	try {
		const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
		if (status) {
			return {
				name: "Git Status",
				severity: "warning",
				message: "Uncommitted changes detected",
				details: status,
			};
		}
		return { name: "Git Status", severity: "pass", message: "Working tree clean" };
	} catch {
		return { name: "Git Status", severity: "warning", message: "Not a git repository" };
	}
}

function checkBuildArtifacts(cwd: string): CheckResult {
	const distDirs = ["dist", "build", ".next", ".astro"];
	for (const dir of distDirs) {
		if (fs.existsSync(path.join(cwd, dir))) {
			return { name: "Build Artifacts", severity: "pass", message: `Build output found: ${dir}/` };
		}
	}
	return { name: "Build Artifacts", severity: "warning", message: "No build artifacts found — did you run build?" };
}

function checkTypeErrors(cwd: string): CheckResult {
	try {
		execSync("bun run tsgo --noEmit 2>&1", { cwd, encoding: "utf-8", timeout: 30000 });
		return { name: "Type Check", severity: "pass", message: "No type errors" };
	} catch (error) {
		const output = error instanceof Error && "stdout" in error ? String((error as any).stdout) : "";
		const errorCount = (output.match(/error TS/g) || []).length;
		return {
			name: "Type Check",
			severity: "fail",
			message: `${errorCount} type error(s) found`,
			details: output.slice(0, 500),
		};
	}
}

function checkSSTSafety(cwd: string): CheckResult {
	const sstConfig = path.join(cwd, "sst.config.ts");
	if (fs.existsSync(sstConfig)) {
		return {
			name: "SST Safety",
			severity: "warning",
			message: "SST project detected — NEVER auto-deploy. Use `sst deploy` manually with verification.",
		};
	}
	// Check if any workspace package has SST
	const packagesDir = path.join(cwd, "packages");
	if (fs.existsSync(packagesDir)) {
		try {
			const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, "sst.config.ts"))) {
					return {
						name: "SST Safety",
						severity: "warning",
						message: `SST found in packages/${entry.name}/ — NEVER auto-deploy.`,
					};
				}
			}
		} catch { /* ignore */ }
	}
	return { name: "SST Safety", severity: "pass", message: "No SST config detected" };
}

function checkEnvFiles(cwd: string): CheckResult {
	const envFiles = [".env", ".env.local", ".env.production"];
	const found = envFiles.filter((f) => fs.existsSync(path.join(cwd, f)));
	if (found.length > 0) {
		return {
			name: "Environment Files",
			severity: "pass",
			message: `Found: ${found.join(", ")}`,
		};
	}
	return { name: "Environment Files", severity: "warning", message: "No .env files found" };
}

/**
 * Run Lighthouse audit (requires lighthouse CLI installed).
 */
export async function runLighthouse(url: string): Promise<CheckResult> {
	try {
		const output = execSync(
			`lighthouse "${url}" --output=json --chrome-flags="--headless --no-sandbox" --only-categories=performance,accessibility,best-practices,seo 2>/dev/null`,
			{ encoding: "utf-8", timeout: 120000 },
		);
		const report = JSON.parse(output);
		const scores = report.categories;
		const summary = Object.entries(scores)
			.map(([key, val]: [string, any]) => `${key}: ${Math.round(val.score * 100)}`)
			.join(", ");

		const minScore = Math.min(...Object.values(scores).map((v: any) => v.score));
		return {
			name: "Lighthouse",
			severity: minScore >= 0.9 ? "pass" : minScore >= 0.5 ? "warning" : "fail",
			message: summary,
		};
	} catch (error) {
		return {
			name: "Lighthouse",
			severity: "warning",
			message: "Lighthouse not available or failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Tag current git state as "last known good" for rollback.
 */
export function tagDeployment(cwd: string, tag?: string): string {
	const deployTag = tag ?? `deploy-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	execSync(`git tag ${deployTag}`, { cwd });
	return deployTag;
}

/**
 * Rollback to a tagged deployment.
 */
export function rollbackTo(cwd: string, tag: string): void {
	execSync(`git checkout ${tag}`, { cwd });
}

/**
 * Get recent deployment tags.
 */
export function getDeployTags(cwd: string, limit = 10): string[] {
	try {
		const output = execSync("git tag -l 'deploy-*' --sort=-creatordate", { cwd, encoding: "utf-8" });
		return output.trim().split("\n").filter(Boolean).slice(0, limit);
	} catch {
		return [];
	}
}
