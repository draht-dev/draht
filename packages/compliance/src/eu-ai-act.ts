import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiDocRequirement, ComplianceFinding } from "./types.js";

/**
 * EU AI Act documentation requirements for AI systems.
 * Based on Article 11 and Annex IV.
 */
export const AI_DOC_REQUIREMENTS: AiDocRequirement[] = [
	{
		id: "EUAI-1",
		article: "Art. 11(1)",
		requirement: "System description",
		description:
			"General description of the AI system including intended purpose, developers, and date of deployment",
	},
	{
		id: "EUAI-2",
		article: "Art. 11(1)",
		requirement: "Data governance",
		description:
			"Description of data used for training, validation, and testing, including data collection and processing methods",
	},
	{
		id: "EUAI-3",
		article: "Art. 11(1)",
		requirement: "Risk management",
		description:
			"Description of risk management measures and known limitations",
	},
	{
		id: "EUAI-4",
		article: "Art. 11(1)",
		requirement: "Human oversight",
		description:
			"Description of human oversight measures and how human control is ensured",
	},
	{
		id: "EUAI-5",
		article: "Art. 11(1)",
		requirement: "Accuracy and robustness",
		description:
			"Expected levels of accuracy, robustness, and cybersecurity measures",
	},
	{
		id: "EUAI-6",
		article: "Art. 11(1)",
		requirement: "Logging capabilities",
		description:
			"Description of logging capabilities and traceability measures",
	},
];

/**
 * Check if a project meets EU AI Act documentation requirements.
 */
export class EuAiActChecker {
	private requirements: AiDocRequirement[];

	constructor(customRequirements?: AiDocRequirement[]) {
		this.requirements = customRequirements ?? AI_DOC_REQUIREMENTS;
	}

	/**
	 * Check project directory for AI Act compliance documentation.
	 */
	checkProject(projectDir: string): ComplianceFinding[] {
		const findings: ComplianceFinding[] = [];

		// Check for AI documentation file
		const docPaths = [
			"AI-SYSTEM-DOCUMENTATION.md",
			"docs/ai-documentation.md",
			"AI-DOC.md",
			".planning/AI-DOCUMENTATION.md",
		];

		let aiDocContent = "";
		for (const docPath of docPaths) {
			const fullPath = join(projectDir, docPath);
			if (existsSync(fullPath)) {
				aiDocContent = readFileSync(fullPath, "utf-8");
				break;
			}
		}

		if (!aiDocContent) {
			findings.push({
				rule: "eu-ai-act/missing-documentation",
				severity: "warning",
				message:
					"No AI system documentation found. If this project uses AI, create AI-SYSTEM-DOCUMENTATION.md",
				recommendation:
					"Create AI-SYSTEM-DOCUMENTATION.md covering: system description, data governance, risk management, human oversight, accuracy metrics, and logging.",
			});
			return findings;
		}

		// Check each requirement
		for (const req of this.requirements) {
			const sectionExists = this.checkSection(aiDocContent, req);
			if (!sectionExists) {
				findings.push({
					rule: `eu-ai-act/${req.id.toLowerCase()}`,
					severity: "warning",
					message: `Missing ${req.requirement} (${req.article}): ${req.description}`,
					recommendation: `Add a section covering: ${req.description}`,
				});
			}
		}

		return findings;
	}

	private checkSection(
		content: string,
		req: AiDocRequirement,
	): boolean {
		const contentLower = content.toLowerCase();
		const keywords = req.requirement.toLowerCase().split(" ");
		return keywords.some((kw) => contentLower.includes(kw));
	}
}
