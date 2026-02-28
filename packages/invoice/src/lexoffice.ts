import type { Invoice, LexofficeConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.lexoffice.io/v1";

/**
 * Lexoffice API client for German freelancer invoicing.
 */
export class LexofficeClient {
	private apiKey: string;
	private baseUrl: string;

	constructor(config: LexofficeConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Lexoffice API error ${response.status}: ${text}`);
		}

		return response.json() as Promise<T>;
	}

	/**
	 * Create an invoice in Lexoffice.
	 */
	async createInvoice(invoice: Invoice): Promise<{ id: string }> {
		const lexInvoice = this.toLexofficeFormat(invoice);
		return this.request<{ id: string }>("POST", "/invoices", lexInvoice);
	}

	/**
	 * List recent invoices.
	 */
	async listInvoices(page = 0, size = 25): Promise<{ content: unknown[]; totalPages: number }> {
		return this.request("GET", `/voucherlist?voucherType=invoice&page=${page}&size=${size}&sort=voucherDate,DESC`);
	}

	/**
	 * Finalize and send an invoice via email.
	 */
	async sendInvoice(invoiceId: string): Promise<void> {
		await this.request("GET", `/invoices/${invoiceId}/document`);
	}

	/**
	 * Convert internal invoice format to Lexoffice API format.
	 */
	private toLexofficeFormat(invoice: Invoice): Record<string, unknown> {
		return {
			voucherDate: invoice.issueDate,
			address: {
				name: invoice.client.name,
				supplement: invoice.client.address,
			},
			lineItems: invoice.items.map((item) => ({
				type: "custom",
				name: item.description,
				quantity: item.quantity,
				unitName: invoice.type === "hourly" ? "Stunden" : "Stück",
				unitPrice: {
					currency: invoice.currency,
					netAmount: item.unitPrice,
					taxRatePercentage: item.taxRate,
				},
			})),
			totalPrice: {
				currency: invoice.currency,
			},
			taxConditions: {
				taxType: "net",
			},
			paymentConditions: {
				paymentTermLabel: `Zahlbar innerhalb von ${Math.round((new Date(invoice.dueDate).getTime() - new Date(invoice.issueDate).getTime()) / 86400000)} Tagen`,
				paymentTermDuration: Math.round(
					(new Date(invoice.dueDate).getTime() - new Date(invoice.issueDate).getTime()) / 86400000,
				),
			},
			introduction: invoice.notes ?? "",
		};
	}
}
