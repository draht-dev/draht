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
					project?: string;
					startDate?: string;
					endDate?: string;
				}) => {
					if (args.type === "fixed" && args.amount && args.description) {
						return generator.fixedPrice(
							args.client,
							args.description,
							args.amount,
						);
					}
					// For hourly, need Toggl integration
					return {
						message:
							"Hourly invoice requires Toggl configuration. Set toggl.apiToken and toggl.workspaceId in config.",
					};
				},
			},
			"/invoice list": {
				description: "List recent invoices from Lexoffice",
				handler: async () => {
					if (!config?.lexoffice?.apiKey) {
						return {
							message:
								"Lexoffice API key not configured. Set lexoffice.apiKey in config.",
						};
					}
					const client = new LexofficeClient(config.lexoffice);
					return client.listInvoices();
				},
			},
			"/invoice send": {
				description: "Send an invoice via Lexoffice",
				handler: async (args: { invoiceId: string }) => {
					if (!config?.lexoffice?.apiKey) {
						return {
							message:
								"Lexoffice API key not configured.",
						};
					}
					const client = new LexofficeClient(config.lexoffice);
					await client.sendInvoice(args.invoiceId);
					return { message: `Invoice ${args.invoiceId} sent.` };
				},
			},
		},
		getGenerator: () => generator,
	};
}
