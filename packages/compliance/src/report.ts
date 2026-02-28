import type { ComplianceFinding, ComplianceReport } from "./types.js";

/**
 * Generate a compliance report from findings.
 */
export function generateReport(
	project: string,
	gdprFindings: ComplianceFinding[],
	euAiFindings: ComplianceFinding[],
): ComplianceReport {
	const allFindings = [...gdprFindings, ...euAiFindings];
	const critical = allFindings.filter((f) => f.severity === "critical").length;
	const warning = allFindings.filter((f) => f.severity === "warning").length;
	const info = allFindings.filter((f) => f.severity === "info").length;

	return {
		timestamp: new Date().toISOString(),
		project,
		checks: {
			gdpr: gdprFindings,
			euAiAct: euAiFindings,
		},
		summary: {
			critical,
			warning,
			info,
			passed: critical === 0,
		},
	};
}

/**
 * Format a compliance report as markdown.
 */
export function formatReportMarkdown(report: ComplianceReport): string {
	const lines: string[] = [
		`# Compliance Report: ${report.project}`,
		"",
		`**Date:** ${report.timestamp}`,
		`**Status:** ${report.summary.passed ? "✅ PASSED" : "❌ FAILED"}`,
		"",
		"## Summary",
		"",
		`| Severity | Count |`,
		`|----------|-------|`,
		`| 🔴 Critical | ${report.summary.critical} |`,
		`| 🟡 Warning | ${report.summary.warning} |`,
		`| 🔵 Info | ${report.summary.info} |`,
		"",
	];

	if (report.checks.gdpr.length > 0) {
		lines.push("## GDPR Findings", "");
		for (const f of report.checks.gdpr) {
			lines.push(
				`### ${severityIcon(f.severity)} ${f.rule}`,
				f.file ? `**File:** ${f.file}${f.line ? `:${f.line}` : ""}` : "",
				`**Message:** ${f.message}`,
				`**Action:** ${f.recommendation}`,
				"",
			);
		}
	}

	if (report.checks.euAiAct.length > 0) {
		lines.push("## EU AI Act Findings", "");
		for (const f of report.checks.euAiAct) {
			lines.push(
				`### ${severityIcon(f.severity)} ${f.rule}`,
				`**Message:** ${f.message}`,
				`**Action:** ${f.recommendation}`,
				"",
			);
		}
	}

	return lines.filter(Boolean).join("\n");
}

function severityIcon(severity: string): string {
	switch (severity) {
		case "critical":
			return "🔴";
		case "warning":
			return "🟡";
		default:
			return "🔵";
	}
}
