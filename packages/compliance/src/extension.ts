import { EuAiActChecker } from "./eu-ai-act.js";
import { GdprScanner } from "./gdpr-scanner.js";
import { formatReportMarkdown, generateReport } from "./report.js";

/**
 * Coding agent extension for compliance checks.
 */
export function createComplianceExtension() {
	const gdprScanner = new GdprScanner();
	const aiChecker = new EuAiActChecker();

	return {
		name: "compliance",
		description: "GDPR and EU AI Act compliance checker",

		/**
		 * Run full compliance check on a directory.
		 */
		check(projectDir: string, projectName?: string): string {
			const gdprFindings = gdprScanner.scanDirectory(projectDir);
			const euAiFindings = aiChecker.checkProject(projectDir);
			const report = generateReport(
				projectName ?? projectDir,
				gdprFindings,
				euAiFindings,
			);
			return formatReportMarkdown(report);
		},

		/**
		 * Quick PII scan on a single file.
		 */
		scanFile(filePath: string) {
			return gdprScanner.scanFile(filePath);
		},
	};
}
