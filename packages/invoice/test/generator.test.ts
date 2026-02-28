import { describe, expect, test } from "bun:test";
import { InvoiceGenerator } from "../src/generator.js";
import type { TimeEntry } from "../src/types.js";

describe("InvoiceGenerator", () => {
	const generator = new InvoiceGenerator({
		defaults: { currency: "EUR", taxRate: 19, paymentTermDays: 14, hourlyRate: 120 },
	});

	test("fixedPrice creates correct invoice", () => {
		const invoice = generator.fixedPrice("Acme GmbH", "Website redesign", 5000);
		expect(invoice.type).toBe("fixed");
		expect(invoice.status).toBe("draft");
		expect(invoice.client.name).toBe("Acme GmbH");
		expect(invoice.items).toHaveLength(1);
		expect(invoice.items[0].totalNet).toBe(5000);
		expect(invoice.totalNet).toBe(5000);
		expect(invoice.totalTax).toBe(950); // 19% of 5000
		expect(invoice.totalGross).toBe(5950);
		expect(invoice.currency).toBe("EUR");
	});

	test("fromTimeEntries creates hourly invoice", () => {
		const entries: TimeEntry[] = [
			{ id: 1, description: "Development", start: "", stop: "", duration: 3600 }, // 1h
			{ id: 2, description: "Development", start: "", stop: "", duration: 7200 }, // 2h
			{ id: 3, description: "Code review", start: "", stop: "", duration: 1800 }, // 0.5h
		];
		const invoice = generator.fromTimeEntries("Client Corp", entries);
		expect(invoice.type).toBe("hourly");
		expect(invoice.items).toHaveLength(2); // grouped by description
		expect(invoice.totalNet).toBe(420); // 3h * 120 + 0.5h * 120
	});

	test("uses custom hourly rate", () => {
		const entries: TimeEntry[] = [
			{ id: 1, description: "Work", start: "", stop: "", duration: 3600 },
		];
		const invoice = generator.fromTimeEntries("Client", entries, 150);
		expect(invoice.totalNet).toBe(150);
	});

	test("invoice has correct dates", () => {
		const invoice = generator.fixedPrice("Client", "Work", 1000);
		expect(invoice.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(invoice.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
