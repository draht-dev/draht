// GSD Domain Validator — glossary extraction and domain naming validation.
// Reads DOMAIN-MODEL.md (preferred) or DOMAIN.md as the glossary source of truth.
// Used by draht-quality-gate.js and exported via @draht/coding-agent.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Extract PascalCase glossary terms from an "## Ubiquitous Language" section.
 * Handles three formats:
 *   - **Term** bold format
 *   - - Term: list format
 *   - | Term | table format
 */
export function extractGlossaryTerms(content: string): Set<string> {
	const terms = new Set<string>();
	if (!content) return terms;

	// Extract only the Ubiquitous Language section (stop at next ## heading)
	const sectionMatch = content.match(/## Ubiquitous Language([\s\S]*?)(?:\n## |\s*$)/);
	const section = sectionMatch ? sectionMatch[1] : "";
	if (!section) return terms;

	// **PascalCase** bold format
	for (const m of section.matchAll(/\*\*([A-Z][a-zA-Z0-9]+)\*\*/g)) {
		terms.add(m[1]);
	}
	// - PascalCase: list format
	for (const m of section.matchAll(/^[-*]\s+([A-Z][a-zA-Z0-9]+)\s*:/gm)) {
		terms.add(m[1]);
	}
	// | PascalCase | table format
	for (const m of section.matchAll(/\|\s*([A-Z][a-zA-Z0-9]+)\s*\|/g)) {
		terms.add(m[1]);
	}

	return terms;
}

/**
 * Returns terms from candidateTerms that are not present in the glossary.
 */
export function validateDomainGlossary(glossaryContent: string, candidateTerms: string[]): string[] {
	if (candidateTerms.length === 0) return [];
	const known = extractGlossaryTerms(glossaryContent);
	return candidateTerms.filter((t) => !known.has(t));
}

/**
 * Load domain content from .planning/DOMAIN-MODEL.md (preferred) or DOMAIN.md.
 * Returns empty string if neither exists.
 */
export function loadDomainContent(cwd: string): string {
	const planningDir = path.join(cwd, ".planning");
	const modelPath = path.join(planningDir, "DOMAIN-MODEL.md");
	if (fs.existsSync(modelPath)) {
		return fs.readFileSync(modelPath, "utf-8");
	}
	const domainPath = path.join(planningDir, "DOMAIN.md");
	if (fs.existsSync(domainPath)) {
		return fs.readFileSync(domainPath, "utf-8");
	}
	return "";
}
