import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EuAiActChecker } from "../src/eu-ai-act.js";
import type { AiDocRequirement } from "../src/types.js";

/**
 * A documentation sample covering all 6 built-in EU AI Act requirements
 * (System description, Data governance, Risk management, Human oversight,
 * Accuracy and robustness, Logging capabilities) via explicit headings that
 * contain each requirement's exact phrase.
 */
const COMPLETE_DOC = `# AI System Documentation

## System description
This document describes our AI system, a recommendation engine developed by
the Draht platform team. It was first deployed to production in Q1 2026 and
serves personalized content suggestions to logged-in users.

## Data governance
Training data was drawn from anonymized user interaction logs collected
under explicit consent. Data is split into training, validation, and test
sets, and undergoes a de-identification pass before use.

## Risk management
Known limitations include reduced accuracy for new users with little
interaction history (cold-start). Mitigations include a fallback to
popularity-based ranking and periodic bias audits.

## Human oversight
A human reviewer signs off on every model deployment, and support staff can
override or disable individual recommendations at any time.

## Accuracy and robustness
The model is evaluated against a held-out test set every quarter and must
maintain at least 90% top-5 accuracy. Adversarial input testing is run
before each release.

## Logging capabilities
All inference requests are logged with a trace ID, model version, and
timestamp, enabling full traceability of individual predictions.
`;

/**
 * A partial documentation sample intentionally missing the "Risk
 * management" and "Human oversight" sections (and avoiding any incidental
 * mention of their key phrases or of the shared "Art. 11(1)" article
 * reference, which would otherwise satisfy every built-in requirement at
 * once).
 */
const PARTIAL_DOC = `# AI System Documentation (Draft)

## System description
This document describes our AI system, a fraud-detection model built by the
platform team and deployed to production in Q2 2026.

## Data governance
Training data consists of anonymized transaction records collected under
customer consent, split into training, validation, and test sets.

## Accuracy and robustness
The model achieves 94% accuracy on the held-out test set and undergoes
regular adversarial security testing.

## Logging capabilities
Every prediction is logged with a trace identifier, model version, and
timestamp for full traceability.
`;

/**
 * A documentation sample with no section headings at all, referencing a
 * requirement only by its article number.
 */
const ARTICLE_ONLY_DOC = `# Compliance Notes

Our AI system's documentation obligations are addressed per Art. 11(1) of
the EU AI Act. See the internal compliance wiki for further detail; this
file intentionally omits section headings.
`;

const DOC_PATHS = [
	"AI-SYSTEM-DOCUMENTATION.md",
	"docs/ai-documentation.md",
	"AI-DOC.md",
	".planning/AI-DOCUMENTATION.md",
];

function tempProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "eu-ai-act-test-"));
}

function writeDoc(projectDir: string, relativePath: string, content: string): void {
	const fullPath = join(projectDir, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

describe("EuAiActChecker", () => {
	test("no documentation file present yields a single missing-documentation finding", () => {
		const dir = tempProjectDir();
		const checker = new EuAiActChecker();

		const findings = checker.checkProject(dir);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("eu-ai-act/missing-documentation");
	});

	test("a complete documentation file covering all 6 requirements yields zero findings", () => {
		const dir = tempProjectDir();
		writeDoc(dir, "AI-SYSTEM-DOCUMENTATION.md", COMPLETE_DOC);
		const checker = new EuAiActChecker();

		const findings = checker.checkProject(dir);

		expect(findings).toHaveLength(0);
	});

	test("a partial documentation file missing 2 sections yields exactly those 2 findings", () => {
		const dir = tempProjectDir();
		writeDoc(dir, "AI-SYSTEM-DOCUMENTATION.md", PARTIAL_DOC);
		const checker = new EuAiActChecker();

		const findings = checker.checkProject(dir);

		expect(findings).toHaveLength(2);
		const rules = findings.map((f) => f.rule).sort();
		expect(rules).toEqual(["eu-ai-act/euai-3", "eu-ai-act/euai-4"]);
	});

	test("a bare article-number reference (no heading) satisfies the article-reference branch", () => {
		const dir = tempProjectDir();
		writeDoc(dir, "AI-SYSTEM-DOCUMENTATION.md", ARTICLE_ONLY_DOC);
		const checker = new EuAiActChecker();

		const findings = checker.checkProject(dir);

		// All 6 built-in requirements share the article "Art. 11(1)", so a bare
		// mention of that article number (with no heading at all) satisfies
		// checkSection's article-reference branch for every requirement.
		expect(findings).toHaveLength(0);
	});

	test("custom requirements replace the built-in 6, not augment them", () => {
		const dir = tempProjectDir();
		// Documentation content unrelated to the custom requirement (and to any
		// of the 6 built-in requirements) — a checker still consulting the
		// built-ins would surface additional findings beyond the custom one.
		writeDoc(dir, "AI-SYSTEM-DOCUMENTATION.md", "# Notes\n\nJust some unrelated project notes.\n");
		const customRequirement: AiDocRequirement = {
			id: "CUSTOM-1",
			article: "Custom Policy 1",
			requirement: "Vendor due diligence",
			description: "Description of third-party vendor risk assessment procedures",
		};
		const checker = new EuAiActChecker([customRequirement]);

		const findings = checker.checkProject(dir);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("eu-ai-act/custom-1");
	});

	describe("candidate documentation paths", () => {
		for (const docPath of DOC_PATHS) {
			test(`finds documentation at ${docPath}`, () => {
				const dir = tempProjectDir();
				writeDoc(dir, docPath, COMPLETE_DOC);
				const checker = new EuAiActChecker();

				const findings = checker.checkProject(dir);

				expect(findings).toHaveLength(0);
			});
		}
	});
});
