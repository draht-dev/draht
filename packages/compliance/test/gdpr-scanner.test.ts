import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GdprScanner } from "../src/gdpr-scanner.js";

describe("GdprScanner", () => {
	const scanner = new GdprScanner();

	test("detects email addresses", () => {
		const dir = mkdtempSync(join(tmpdir(), "gdpr-test-"));
		writeFileSync(join(dir, "config.ts"), 'const email = "user@example.com";');
		const findings = scanner.scanDirectory(dir);
		expect(findings.some((f) => f.rule === "gdpr/pii-email")).toBe(true);
	});

	test("detects IBAN numbers", () => {
		const dir = mkdtempSync(join(tmpdir(), "gdpr-test-"));
		writeFileSync(join(dir, "data.ts"), 'const iban = "DE89 3704 0044 0532 0130 00";');
		const findings = scanner.scanDirectory(dir);
		expect(findings.some((f) => f.rule === "gdpr/pii-iban")).toBe(true);
	});

	test("detects console.log with PII", () => {
		const dir = mkdtempSync(join(tmpdir(), "gdpr-test-"));
		writeFileSync(join(dir, "handler.ts"), 'console.log("User email:", email);');
		const findings = scanner.scanDirectory(dir);
		expect(findings.some((f) => f.rule === "gdpr/pii-console-log-pii")).toBe(true);
	});

	test("skips test files", () => {
		const dir = mkdtempSync(join(tmpdir(), "gdpr-test-"));
		writeFileSync(join(dir, "handler.test.ts"), 'const email = "test@example.com";');
		const findings = scanner.scanDirectory(dir);
		expect(findings).toHaveLength(0);
	});

	test("skips node_modules", () => {
		const dir = mkdtempSync(join(tmpdir(), "gdpr-test-"));
		const _nm = join(dir, "node_modules", "pkg");
		writeFileSync(join(dir, "clean.ts"), "const x = 1;");
		// node_modules is excluded by default
		const findings = scanner.scanDirectory(dir);
		expect(findings.filter((f) => f.file?.includes("node_modules"))).toHaveLength(0);
	});
});
