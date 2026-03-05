/**
 * Tests for src/gsd/domain-validator.ts
 * Domain glossary extraction and validation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractGlossaryTerms, loadDomainContent, validateDomainGlossary } from "../src/gsd/domain-validator.js";
import {
	extractGlossaryTerms as extractFromIndex,
	loadDomainContent as loadFromIndex,
	validateDomainGlossary as validateFromIndex,
} from "../src/gsd/index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "domain-validator-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractGlossaryTerms", () => {
	it("extracts **Bold** format terms", () => {
		const content =
			"## Ubiquitous Language\n\n**Order** — a customer request\n**LineItem** — a product in an Order\n";
		const terms = extractGlossaryTerms(content);
		expect(terms.has("Order")).toBe(true);
		expect(terms.has("LineItem")).toBe(true);
	});

	it("extracts - Term: list format terms", () => {
		const content = "## Ubiquitous Language\n\n- Order: a customer request\n- LineItem: a product\n";
		const terms = extractGlossaryTerms(content);
		expect(terms.has("Order")).toBe(true);
		expect(terms.has("LineItem")).toBe(true);
	});

	it("extracts | Term | table format terms", () => {
		const content =
			"## Ubiquitous Language\n\n| Term | Definition |\n|------|------------|\n| Order | A request |\n| LineItem | An item |\n";
		const terms = extractGlossaryTerms(content);
		expect(terms.has("Order")).toBe(true);
		expect(terms.has("LineItem")).toBe(true);
	});

	it("returns empty Set for empty string", () => {
		const terms = extractGlossaryTerms("");
		expect(terms.size).toBe(0);
	});

	it("only extracts from Ubiquitous Language section (not rest of doc)", () => {
		const content =
			"## Bounded Contexts\n\nSomeContext handles stuff.\n\n## Ubiquitous Language\n\n**Order** — thing\n\n## Other Section\n\n**NotATerm** — ignore\n";
		const terms = extractGlossaryTerms(content);
		expect(terms.has("Order")).toBe(true);
		// NotATerm is after a new ## heading — should not be included
		expect(terms.has("NotATerm")).toBe(false);
	});
});

describe("validateDomainGlossary", () => {
	const glossaryContent = "## Ubiquitous Language\n\n**Order** — a customer request\n**LineItem** — a product\n";

	it("returns unknown terms not in glossary", () => {
		const unknown = validateDomainGlossary(glossaryContent, ["Order", "LineItem", "Invoice"]);
		expect(unknown).toEqual(["Invoice"]);
	});

	it("returns empty array when all terms are known", () => {
		const unknown = validateDomainGlossary(glossaryContent, ["Order", "LineItem"]);
		expect(unknown).toEqual([]);
	});

	it("returns all terms when glossary is empty", () => {
		const unknown = validateDomainGlossary("", ["Order"]);
		expect(unknown).toEqual(["Order"]);
	});

	it("returns empty array for empty candidate list", () => {
		const unknown = validateDomainGlossary(glossaryContent, []);
		expect(unknown).toEqual([]);
	});
});

describe("loadDomainContent", () => {
	it("returns DOMAIN-MODEL.md content when it exists", () => {
		fs.mkdirSync(path.join(tmpDir, ".planning"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".planning", "DOMAIN-MODEL.md"),
			"# Domain Model\n## Ubiquitous Language\n**Order** — thing\n",
		);
		const content = loadDomainContent(tmpDir);
		expect(content).toContain("Domain Model");
		expect(content).toContain("Order");
	});

	it("falls back to DOMAIN.md when DOMAIN-MODEL.md does not exist", () => {
		fs.mkdirSync(path.join(tmpDir, ".planning"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".planning", "DOMAIN.md"),
			"# Domain\n## Ubiquitous Language\n**Invoice** — bill\n",
		);
		const content = loadDomainContent(tmpDir);
		expect(content).toContain("Invoice");
	});

	it("prefers DOMAIN-MODEL.md over DOMAIN.md when both exist", () => {
		fs.mkdirSync(path.join(tmpDir, ".planning"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".planning", "DOMAIN-MODEL.md"), "from-model");
		fs.writeFileSync(path.join(tmpDir, ".planning", "DOMAIN.md"), "from-domain");
		const content = loadDomainContent(tmpDir);
		expect(content).toBe("from-model");
	});

	it("returns empty string when neither file exists", () => {
		const content = loadDomainContent(tmpDir);
		expect(content).toBe("");
	});
});

describe("gsd/index re-exports for domain-validator", () => {
	it("re-exports extractGlossaryTerms", () => {
		expect(extractFromIndex).toBeDefined();
		expect(typeof extractFromIndex).toBe("function");
	});

	it("re-exports validateDomainGlossary", () => {
		expect(validateFromIndex).toBeDefined();
		expect(typeof validateFromIndex).toBe("function");
	});

	it("re-exports loadDomainContent", () => {
		expect(loadFromIndex).toBeDefined();
		expect(typeof loadFromIndex).toBe("function");
	});
});

describe("draht-quality-gate.js domain check hardening", () => {
	const gateFile = path.join(path.dirname(new URL(import.meta.url).pathname), "../hooks/gsd/draht-quality-gate.js");

	it("references DOMAIN-MODEL.md (prefers it over DOMAIN.md)", () => {
		const content = fs.readFileSync(gateFile, "utf-8");
		expect(content).toContain("DOMAIN-MODEL.md");
	});

	it("has extractGlossaryTerms inline helper", () => {
		const content = fs.readFileSync(gateFile, "utf-8");
		expect(content).toMatch(/function extractGlossaryTerms/);
	});

	it("handles **Bold** format in glossary extraction", () => {
		const content = fs.readFileSync(gateFile, "utf-8");
		expect(content).toMatch(/\\\*\\\*/);
	});

	it("handles - Term: list format in glossary extraction", () => {
		const content = fs.readFileSync(gateFile, "utf-8");
		// The inline extractGlossaryTerms must handle list format
		expect(content).toMatch(/\[-\*\]\\s\+/);
	});
});
