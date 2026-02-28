import { InvoiceGenerator } from "./generator.js";
import { LexofficeClient } from "./lexoffice.js";
import { TogglClient } from "./toggl.js";
import type { InvoiceConfig } from "./types.js";

/**
 * Coding agent extension for invoice management.
 * Commands: /invoice create, /invoice list, /invoice send
 */
export function createInvoiceExtension(config?: Partial<InvoiceConfig>) {
	const generator = new InvoiceGenerator(config);

	return {
		name: "invoice",
		description: "Invoice generator with Lexoffice and Toggl integration",
		commands: {
			"/invoice create": {
				description: "Create a new invoice (hourly or fixed-price)",
				handler: async (args: {
					client: string;
					type: "hourly" | "fixed";
					amount?: number;
					description?: string;
					hourlyRate?: number;
					project?: string;
					startDate?: string;
					endDate?: string;
				}) => {
					if (args.type === "fixed") {
						if (!args.amount || !args.description) {
							return { error: "Fixed-price invoice requires --amount and --description" };
						}
						const invoice = generator.fixedPrice(args.client, args.description, args.amount);

						// If Lexoffice configured, create it there too
						if (config?.lexoffice?.apiKey) {
							const lexoffice = new LexofficeClient(config.lexoffice);
							const result = await lexoffice.createInvoice(invoice);
							return { invoice, lexofficeId: result.id, message: `Invoice created in Lexoffice: ${result.id}` };
						}
						return { invoice, message: "Invoice generated (Lexoffice not configured — draft only)" };
					}

					// Hourly: pull time entries from Toggl
					if (!config?.toggl?.apiToken || !config?.toggl?.workspaceId) {
						return { error: "Hourly invoice requires toggl.apiToken and toggl.workspaceId in config" };
					}
					if (!args.startDate || !args.endDate) {
						return { error: "Hourly invoice requires --startDate and --endDate (YYYY-MM-DD)" };
					}

					const toggl = new TogglClient(config.toggl);
					const projectFilter = args.project ?? args.client;
					const { entries, totalHours } = await toggl.getProjectTime(projectFilter, args.startDate, args.endDate);

					if (entries.length === 0) {
						return {
							error: `No Toggl entries found for "${projectFilter}" between ${args.startDate} and ${args.endDate}`,
						};
					}

					const invoice = generator.fromTimeEntries(args.client, entries, args.hourlyRate);

					if (config?.lexoffice?.apiKey) {
						const lexoffice = new LexofficeClient(config.lexoffice);
						const result = await lexoffice.createInvoice(invoice);
						return {
							invoice,
							totalHours,
							entriesCount: entries.length,
							lexofficeId: result.id,
							message: `Invoice created from ${entries.length} time entries (${totalHours}h) → Lexoffice: ${result.id}`,
						};
					}

					return {
						invoice,
						totalHours,
						entriesCount: entries.length,
						message: `Invoice generated from ${entries.length} time entries (${totalHours}h) — Lexoffice not configured`,
					};
				},
			},
			"/invoice list": {
				description: "List recent invoices from Lexoffice",
				handler: async (args?: { page?: number }) => {
					if (!config?.lexoffice?.apiKey) {
						return { error: "Lexoffice API key not configured. Set lexoffice.apiKey." };
					}
					const client = new LexofficeClient(config.lexoffice);
					return client.listInvoices(args?.page ?? 0);
				},
			},
			"/invoice send": {
				description: "Finalize and send an invoice via Lexoffice",
				handler: async (args: { invoiceId: string }) => {
					if (!args.invoiceId) {
						return { error: "Missing --invoiceId" };
					}
					if (!config?.lexoffice?.apiKey) {
						return { error: "Lexoffice API key not configured." };
					}
					const client = new LexofficeClient(config.lexoffice);
					await client.sendInvoice(args.invoiceId);
					return { message: `Invoice ${args.invoiceId} finalized and sent.` };
				},
			},
		},
		getGenerator: () => generator,
	};
}
