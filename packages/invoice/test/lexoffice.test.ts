import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LexofficeClient } from "../src/lexoffice.js";
import type { Invoice } from "../src/types.js";

interface RecordedCall {
	url: string;
	init?: RequestInit;
}

const originalFetch = globalThis.fetch;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
	return {
		type: "fixed",
		status: "draft",
		client: { name: "Acme GmbH", address: "Musterstr. 1, 12345 Berlin" },
		items: [{ description: "Website redesign", quantity: 1, unitPrice: 5000, taxRate: 19, totalNet: 5000 }],
		currency: "EUR",
		issueDate: "2026-07-01",
		dueDate: "2026-07-15",
		totalNet: 5000,
		totalTax: 950,
		totalGross: 5950,
		...overrides,
	};
}

describe("LexofficeClient", () => {
	let calls: RecordedCall[] = [];

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	/** Stub globalThis.fetch to return a single canned response and record every call. */
	function stubFetch(status: number, body: unknown = null, rawText?: string) {
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			const text = rawText ?? JSON.stringify(body);
			return new Response(text, { status, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
	}

	function authHeader(init?: RequestInit): string | undefined {
		return (init?.headers as Record<string, string> | undefined)?.Authorization;
	}

	test("createInvoice returns the created id and sends the Lexoffice voucher shape", async () => {
		stubFetch(200, { id: "inv-123" });
		const client = new LexofficeClient({ apiKey: "test-key" });

		const result = await client.createInvoice(makeInvoice());

		expect(result.id).toBe("inv-123");
		expect(calls).toHaveLength(1);
		const { url, init } = calls[0];
		expect(url).toBe("https://api.lexoffice.io/v1/invoices");
		expect(init?.method).toBe("POST");

		const body = JSON.parse(init?.body as string);
		expect(body.voucherDate).toBe("2026-07-01");
		expect(body.address.name).toBe("Acme GmbH");
		expect(body.lineItems).toHaveLength(1);
		expect(body.lineItems[0].quantity).toBe(1);
		expect(body.lineItems[0].unitPrice.netAmount).toBe(5000);
		expect(body.lineItems[0].unitPrice.taxRatePercentage).toBe(19);
		expect(body.taxConditions).toEqual({ taxType: "net" });
	});

	test("createInvoice uses 'Stunden' unitName for hourly invoices", async () => {
		stubFetch(200, { id: "inv-1" });
		const client = new LexofficeClient({ apiKey: "test-key" });

		await client.createInvoice(makeInvoice({ type: "hourly" }));

		const body = JSON.parse(calls[0].init?.body as string);
		expect(body.lineItems[0].unitName).toBe("Stunden");
	});

	test("createInvoice uses 'Stück' unitName for fixed invoices", async () => {
		stubFetch(200, { id: "inv-2" });
		const client = new LexofficeClient({ apiKey: "test-key" });

		await client.createInvoice(makeInvoice({ type: "fixed" }));

		const body = JSON.parse(calls[0].init?.body as string);
		expect(body.lineItems[0].unitName).toBe("Stück");
	});

	test("listInvoices sends pagination params and passes through the response", async () => {
		const content = [{ id: "a" }, { id: "b" }];
		stubFetch(200, { content, totalPages: 2 });
		const client = new LexofficeClient({ apiKey: "test-key" });

		const result = await client.listInvoices(1, 10);

		expect(calls).toHaveLength(1);
		const { url, init } = calls[0];
		expect(url).toContain("page=1");
		expect(url).toContain("size=10");
		expect(init?.method).toBe("GET");
		expect(result.totalPages).toBe(2);
		expect(result.content).toEqual(content);
	});

	test("sendInvoice hits the /invoices/<id>/document endpoint", async () => {
		stubFetch(200);
		const client = new LexofficeClient({ apiKey: "test-key" });

		await client.sendInvoice("inv-999");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.lexoffice.io/v1/invoices/inv-999/document");
	});

	test("rejects with an Error including the status code and body text on non-2xx responses", async () => {
		stubFetch(422, undefined, "Validation failed: missing lineItems");
		const client = new LexofficeClient({ apiKey: "test-key" });

		await expect(client.createInvoice(makeInvoice())).rejects.toThrow(/422.*Validation failed: missing lineItems/s);
	});

	test("every request carries the Authorization: Bearer <apiKey> header", async () => {
		stubFetch(200, { id: "inv-1", content: [], totalPages: 0 });
		const client = new LexofficeClient({ apiKey: "super-secret-token" });

		await client.createInvoice(makeInvoice());
		await client.listInvoices();
		await client.sendInvoice("inv-1");

		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(authHeader(call.init)).toBe("Bearer super-secret-token");
		}
	});
});
