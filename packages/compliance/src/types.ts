/**
 * Compliance finding severity.
 */
export type Severity = "critical" | "warning" | "info";

/**
 * A single compliance finding.
 */
export interface ComplianceFinding {
	rule: string;
	severity: Severity;
	file?: string;
	line?: number;
	message: string;
	recommendation: string;
}

/**
 * Compliance check result.
 */
export interface ComplianceReport {
	timestamp: string;
	project: string;
	checks: {
		gdpr: ComplianceFinding[];
		euAiAct: ComplianceFinding[];
	};
	summary: {
		critical: number;
		warning: number;
		info: number;
		passed: boolean;
	};
}

/**
 * PII pattern for GDPR scanning.
 */
export interface PiiPattern {
	name: string;
	regex: RegExp;
	severity: Severity;
	description: string;
}

/**
 * EU AI Act documentation requirement.
 */
export interface AiDocRequirement {
	id: string;
	article: string;
	requirement: string;
	description: string;
}
