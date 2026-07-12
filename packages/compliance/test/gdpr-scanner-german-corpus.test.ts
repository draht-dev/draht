import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GdprScanner } from "../src/gdpr-scanner.js";

/**
 * These fixtures model realistic German business-context files — a customer
 * record, PII-free German prose/code, and an export with PII interspersed
 * among normal German comments — rather than the single hardcoded synthetic
 * lines used in gdpr-scanner.test.ts. Each fixture below has been manually
 * checked line-by-line against every pattern in PII_PATTERNS so the expected
 * finding counts are exact, not just "contains at least one".
 */

const CUSTOMER_RECORD = `// Kundendatensatz für Rechnungsstellung
// Datenschutzhinweis: Enthält personenbezogene Daten (Art. 6 DSGVO)

export const kunde = {
	name: "Max Mustermann",
	email: "max.mustermann@musterfirma.de",
	iban: "DE89370400440532013000",
	telefon: "+49 30 12345678",
	adresse: "Musterstraße 12, 10115 Berlin",
};
`;

const NO_PII_GERMAN_PROSE = `// Dieses Modul beschreibt abstrakt, wie Kundendaten verarbeitet werden.
// Es enthält keine echten personenbezogenen Daten, nur Platzhalter.

export function verarbeiteKundendaten(kunde: { referenz: string }): void {
	// Die Referenznummer dient nur zur internen Zuordnung, keine Bankdaten.
	const referenz = kunde.referenz;
	console.log("Verarbeitung abgeschlossen für Referenz:", referenz);
}
`;

const INTERSPERSED_RECORDS = `// Mitarbeiterexport für die Buchhaltung
// Bitte nur intern verwenden, nicht an Dritte weitergeben.

import { formatDate } from "./utils.js";

// Erster Datensatz: Vertrieb, Region Süd
const mitarbeiter1 = {
	name: "Erika Musterfrau",
	position: "Senior Consultant",
	email: "erika.musterfrau@beispielfirma.de",
};

// Kontoverbindung für Spesenabrechnung
const bankverbindung1 = "DE12500105170648489890";

function formatiereKontakt(person: { telefon: string }): string {
	// Rückruf am Nachmittag erwünscht
	return \`Rückruf bitte unter \${person.telefon}\`;
}

// Zweiter Datensatz: IT-Abteilung
const kontakt2 = "+49 89 987654321";

// Ende der Datei — keine weiteren personenbezogenen Daten.
`;

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "gdpr-german-corpus-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

describe("GdprScanner - German corpus accuracy", () => {
	const scanner = new GdprScanner();

	test("finds email, IBAN, and German phone number in a realistic customer record", () => {
		const dir = makeFixtureDir({ "kunde.ts": CUSTOMER_RECORD });
		const findings = scanner.scanDirectory(dir);

		expect(findings.some((f) => f.rule === "gdpr/pii-email")).toBe(true);
		expect(findings.some((f) => f.rule === "gdpr/pii-iban")).toBe(true);
		// GdprScanner does ship a German phone-number pattern (`german-phone`,
		// matching "+49 <area> <number>"), so we assert on it directly instead
		// of scoping this test down to email/IBAN only.
		expect(findings.some((f) => f.rule === "gdpr/pii-german-phone")).toBe(true);

		// One PII field per line, three PII-bearing lines (email/iban/telefon),
		// name/adresse lines are clean -> exactly 3 findings, no extras.
		expect(findings).toHaveLength(3);
	});

	test("produces no false positives on German prose/code discussing PII abstractly", () => {
		const dir = makeFixtureDir({ "datenschutz-doku.ts": NO_PII_GERMAN_PROSE });
		const findings = scanner.scanDirectory(dir);

		expect(findings).toHaveLength(0);
	});

	test("finds every PII instance when interspersed with German code and comments", () => {
		const dir = makeFixtureDir({ "mitarbeiter-export.ts": INTERSPERSED_RECORDS });
		const findings = scanner.scanDirectory(dir);

		const byRule = (rule: string) => findings.filter((f) => f.rule === rule);

		expect(byRule("gdpr/pii-email")).toHaveLength(1);
		expect(byRule("gdpr/pii-iban")).toHaveLength(1);
		expect(byRule("gdpr/pii-german-phone")).toHaveLength(1);
		// PII is spread across lines 10 (email), 14 (iban), and 23 (phone),
		// with clean German comments/code on every line in between -
		// accuracy should not degrade just because PII isn't the only
		// content in the file.
		expect(findings).toHaveLength(3);
	});

	test("computes precision and recall across the full German corpus", () => {
		const dir = makeFixtureDir({
			"kunde.ts": CUSTOMER_RECORD,
			"datenschutz-doku.ts": NO_PII_GERMAN_PROSE,
			"mitarbeiter-export.ts": INTERSPERSED_RECORDS,
		});
		const findings = scanner.scanDirectory(dir);

		// Ground truth for this corpus, established by manual review above:
		// 3 real PII items in the customer record (email/iban/phone) + 0 in
		// the PII-free prose file + 3 real PII items in the interspersed
		// export (email/iban/phone) = 6 true positives, 0 false positives,
		// 0 false negatives.
		const expectedTruePositives = 6;
		const piiRules = new Set(["gdpr/pii-email", "gdpr/pii-iban", "gdpr/pii-german-phone"]);

		const truePositives = findings.filter((f) => piiRules.has(f.rule)).length;
		const falsePositives = findings.filter((f) => !piiRules.has(f.rule)).length;

		// Total actual findings vs. total expected findings (not a boolean
		// some() check).
		expect(findings).toHaveLength(expectedTruePositives);
		expect(truePositives).toBe(expectedTruePositives);
		expect(falsePositives).toBe(0);

		const precision = findings.length === 0 ? 1 : truePositives / findings.length;
		const recall = truePositives / expectedTruePositives;

		expect(precision).toBe(1);
		expect(recall).toBe(1);
	});
});
