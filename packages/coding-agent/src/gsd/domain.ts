// GSD Domain module — domain model and codebase mapping operations.
// Part of the draht GSD (Get Shit Done) methodology.
// Exported via src/gsd/index.ts and @draht/coding-agent.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PLANNING = ".planning";
const VALUE_OBJECT_NAME = /(Address|Amount|Code|Email|Id|Identifier|Key|Money|Price|Value)$/;

export type MapCodebaseResult = string[] & {
	entities: string[];
	valueObjects: string[];
};

function planningPath(cwd: string, ...segments: string[]): string {
	return path.join(cwd, PLANNING, ...segments);
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureCodebaseExists(cwd: string): void {
	if (!fs.existsSync(cwd)) {
		throw new Error(`Codebase path does not exist: ${cwd}`);
	}
}

function timestamp(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function toRelativeCodePath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath).split(path.sep).join("/");
}

function listCodeFiles(cwd: string): string[] {
	const codeFiles: string[] = [];
	const ignoredDirs = new Set([".git", ".planning", "dist", "node_modules"]);
	const pendingDirs = [cwd];

	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		if (!currentDir) {
			continue;
		}

		const entries = fs.readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (!ignoredDirs.has(entry.name)) {
					pendingDirs.push(entryPath);
				}
				continue;
			}

			if (entry.isFile() && /\.(go|ts)$/.test(entry.name)) {
				codeFiles.push(entryPath);
			}
		}
	}

	return codeFiles.sort((left, right) => toRelativeCodePath(cwd, left).localeCompare(toRelativeCodePath(cwd, right)));
}

function extractExportedTerms(fileContent: string): string[] {
	const terms = new Set<string>();
	const exportPattern = /export\s+(?:interface|type|class)\s+([A-Z][A-Za-z0-9_]*)/g;

	for (const match of fileContent.matchAll(exportPattern)) {
		terms.add(match[1]);
	}

	return [...terms].sort((left, right) => left.localeCompare(right));
}

function classifyTerms(terms: string[]): { entities: string[]; valueObjects: string[] } {
	const entities: string[] = [];
	const valueObjects: string[] = [];

	for (const term of terms) {
		if (VALUE_OBJECT_NAME.test(term)) {
			valueObjects.push(term);
			continue;
		}

		entities.push(term);
	}

	return { entities, valueObjects };
}

function scanStructuredDomainTerms(cwd: string): { entities: string[]; valueObjects: string[] } {
	const uniqueTerms = new Set<string>();

	for (const filePath of listCodeFiles(cwd)) {
		const fileContent = fs.readFileSync(filePath, "utf-8");
		for (const term of extractExportedTerms(fileContent)) {
			uniqueTerms.add(term);
		}
	}

	const sortedTerms = [...uniqueTerms].sort((left, right) => left.localeCompare(right));
	return classifyTerms(sortedTerms);
}

function attachStructuredDomainTerms(
	files: string[],
	structuredTerms: { entities: string[]; valueObjects: string[] },
): MapCodebaseResult {
	return Object.assign(files, structuredTerms);
}

/**
 * Generate a DOMAIN-MODEL.md scaffold from PROJECT.md.
 * Requires .planning/PROJECT.md to exist.
 * Returns the path to the created file.
 */
export function createDomainModel(cwd: string): string {
	const projectPath = planningPath(cwd, "PROJECT.md");
	if (!fs.existsSync(projectPath)) {
		throw new Error("No PROJECT.md found — run create-project first");
	}

	const outPath = planningPath(cwd, "DOMAIN-MODEL.md");
	const tmpl = `# Domain Model

## Bounded Contexts
[Extract from PROJECT.md — identify distinct areas of responsibility]

## Context Map
[How bounded contexts interact — upstream/downstream, shared kernel, etc.]

## Entities
[Core domain objects with identity]

## Value Objects
[Immutable objects defined by attributes]

## Aggregates
[Cluster of entities with a root — transactional boundary]

## Domain Events
[Things that happen in the domain]

## Ubiquitous Language Glossary
| Term | Context | Definition |
|------|---------|------------|
| [term] | [context] | [definition] |

---
Generated from PROJECT.md: ${timestamp()}
`;
	fs.writeFileSync(outPath, tmpl, "utf-8");
	return outPath;
}

/**
 * Scan the codebase and write .planning/codebase/ analysis files.
 * Returns array of created file paths.
 */
export function mapCodebase(cwd: string): MapCodebaseResult {
	ensureCodebaseExists(cwd);

	const outDir = planningPath(cwd, "codebase");
	ensureDir(outDir);
	const structuredTerms = scanStructuredDomainTerms(cwd);

	// Gather file tree
	let tree = "";
	try {
		tree = execSync(
			`find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.planning/*' | head -200`,
			{ cwd, encoding: "utf-8" },
		);
	} catch {
		tree = "(unable to list files)";
	}

	// Gather package info
	let pkgJson: {
		name?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	} | null = null;
	try {
		pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
	} catch {
		// not a Node.js project
	}

	const stackPath = path.join(outDir, "STACK.md");
	fs.writeFileSync(
		stackPath,
		`# Technology Stack\n\nGenerated: ${timestamp()}\n\n## File Tree (first 200 files)\n\`\`\`\n${tree}\`\`\`\n\n## Package Info\n\`\`\`json\n${pkgJson ? JSON.stringify({ name: pkgJson.name, dependencies: pkgJson.dependencies, devDependencies: pkgJson.devDependencies }, null, 2) : "No package.json found"}\n\`\`\`\n\n## TODO\n- [ ] Fill in languages, versions, frameworks\n- [ ] Document build tools and runtime\n`,
		"utf-8",
	);

	const archPath = path.join(outDir, "ARCHITECTURE.md");
	fs.writeFileSync(
		archPath,
		`# Architecture\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Document file/directory patterns\n- [ ] Map module boundaries\n- [ ] Describe data flow\n`,
		"utf-8",
	);

	const convPath = path.join(outDir, "CONVENTIONS.md");
	fs.writeFileSync(
		convPath,
		`# Conventions\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Document code style patterns\n- [ ] Document testing patterns\n- [ ] Document error handling approach\n`,
		"utf-8",
	);

	const concernsPath = path.join(outDir, "CONCERNS.md");
	fs.writeFileSync(
		concernsPath,
		`# Concerns\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Identify technical debt\n- [ ] Flag security concerns\n- [ ] Note missing tests\n`,
		"utf-8",
	);

	// Domain model extraction
	let domainHints = "";
	try {
		const types = execSync(
			`grep -rn 'export\\s\\+\\(interface\\|type\\|class\\)' --include='*.ts' --include='*.go' . 2>/dev/null | grep -v node_modules | grep -v dist | head -50`,
			{ cwd, encoding: "utf-8" },
		).trim();
		if (types) domainHints += `## Types/Interfaces (potential entities)\n\`\`\`\n${types}\n\`\`\`\n\n`;
	} catch {
		// no ts/go files
	}
	try {
		const dirs = execSync(
			`find . -type d -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | sort`,
			{ cwd, encoding: "utf-8" },
		).trim();
		if (dirs) domainHints += `## Directory Structure (potential bounded contexts)\n\`\`\`\n${dirs}\n\`\`\`\n`;
	} catch {
		// ignore
	}

	const hintsPath = path.join(outDir, "DOMAIN-HINTS.md");
	fs.writeFileSync(
		hintsPath,
		`# Domain Model Hints\n\nGenerated: ${timestamp()}\n\nExtracted from codebase to help identify domain model.\n\n${domainHints}\n## TODO\n- [ ] Identify entities vs value objects\n- [ ] Map bounded contexts from directory structure\n- [ ] Define ubiquitous language glossary\n`,
		"utf-8",
	);

	return attachStructuredDomainTerms([stackPath, archPath, convPath, concernsPath, hintsPath], structuredTerms);
}
