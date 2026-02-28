import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ComplianceFinding, PiiPattern } from "./types.js";

/**
 * Common PII patterns to detect in code.
 */
export const PII_PATTERNS: PiiPattern[] = [
	{
		name: "email",
		regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
		severity: "warning",
		description: "Email address found — may contain PII",
	},
	{
		name: "ip-address",
		regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
		severity: "info",
		description: "IP address found — considered PII under GDPR",
	},
	{
		name: "german-phone",
		regex: /\+49[\s-]?\d{2,4}[\s-]?\d{4,8}/g,
		severity: "warning",
		description: "German phone number found",
	},
	{
		name: "iban",
		regex: /[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,4}/g,
		severity: "critical",
		description: "IBAN bank account number found",
	},
	{
		name: "credit-card",
		regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
		severity: "critical",
		description: "Potential credit card number found",
	},
	{
		name: "console-log-pii",
		regex: /console\.(log|info|warn|error)\s*\(.*?(email|password|token|secret|apiKey|api_key|ssn|name|address)/gi,
		severity: "critical",
		description: "Potential PII logged to console",
	},
	{
		name: "env-secret",
		regex: /process\.env\.(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)/g,
		severity: "warning",
		description: "Secret accessed from environment — ensure not logged",
	},
];

/**
 * Scan files for PII patterns.
 */
export class GdprScanner {
	private patterns: PiiPattern[];
	private excludeDirs = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		".next",
		"coverage",
	]);
	private includeExtensions = new Set([
		".ts",
		".tsx",
		".js",
		".jsx",
		".json",
		".env",
		".yaml",
		".yml",
		".toml",
	]);

	constructor(customPatterns?: PiiPattern[]) {
		this.patterns = customPatterns ?? PII_PATTERNS;
	}

	/**
	 * Scan a directory recursively for PII.
	 */
	scanDirectory(dir: string): ComplianceFinding[] {
		const findings: ComplianceFinding[] = [];
		this.walkDir(dir, dir, findings);
		return findings;
	}

	/**
	 * Scan a single file for PII.
	 */
	scanFile(filePath: string): ComplianceFinding[] {
		const findings: ComplianceFinding[] = [];
		try {
			const content = readFileSync(filePath, "utf-8");
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				for (const pattern of this.patterns) {
					pattern.regex.lastIndex = 0;
					if (pattern.regex.test(lines[i])) {
						// Skip test files and comments
						if (filePath.includes(".test.") || filePath.includes(".spec."))
							continue;
						findings.push({
							rule: `gdpr/pii-${pattern.name}`,
							severity: pattern.severity,
							file: filePath,
							line: i + 1,
							message: pattern.description,
							recommendation: `Review line ${i + 1} for PII exposure. Ensure data is not logged, stored unencrypted, or transmitted insecurely.`,
						});
					}
				}
			}
		} catch {
			// Skip unreadable files
		}
		return findings;
	}

	private walkDir(
		baseDir: string,
		currentDir: string,
		findings: ComplianceFinding[],
	): void {
		const entries = readdirSync(currentDir);
		for (const entry of entries) {
			if (this.excludeDirs.has(entry)) continue;
			const fullPath = join(currentDir, entry);
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				this.walkDir(baseDir, fullPath, findings);
			} else {
				const ext = entry.slice(entry.lastIndexOf("."));
				if (this.includeExtensions.has(ext)) {
					const relPath = relative(baseDir, fullPath);
					for (const f of this.scanFile(fullPath)) {
						findings.push({ ...f, file: relPath });
					}
				}
			}
		}
	}
}
