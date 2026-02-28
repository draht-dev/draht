import type { Invoice, InvoiceConfig, LineItem, TimeEntry } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * Generate invoices from time entries or fixed-price data.
 */
export class InvoiceGenerator {
	private config: InvoiceConfig;

	constructor(config?: Partial<InvoiceConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Create an hourly invoice from time entries.
	 */
	fromTimeEntries(
		clientName: string,
		entries: TimeEntry[],
		hourlyRate?: number,
	): Invoice {
		const rate = hourlyRate ?? this.config.defaults.hourlyRate ?? 120;
		const taxRate = this.config.defaults.taxRate;

		// Group entries by description
		const grouped = new Map<string, number>();
		for (const entry of entries) {
			const desc = entry.description || "Development";
			const hours = entry.duration / 3600;
			grouped.set(desc, (grouped.get(desc) ?? 0) + hours);
		}

		const items: LineItem[] = Array.from(grouped.entries()).map(
			([description, hours]) => {
				const roundedHours = Math.round(hours * 100) / 100;
				const totalNet = Math.round(roundedHours * rate * 100) / 100;
				return {
					description,
					quantity: roundedHours,
					unitPrice: rate,
					taxRate,
					totalNet,
				};
			},
		);

		return this.buildInvoice("hourly", clientName, items);
	}

	/**
	 * Create a fixed-price invoice.
	 */
	fixedPrice(
		clientName: string,
		description: string,
		amount: number,
	): Invoice {
		const taxRate = this.config.defaults.taxRate;
		const items: LineItem[] = [
			{
				description,
				quantity: 1,
				unitPrice: amount,
				taxRate,
				totalNet: amount,
			},
		];

		return this.buildInvoice("fixed", clientName, items);
	}

	private buildInvoice(
		type: "hourly" | "fixed",
		clientName: string,
		items: LineItem[],
	): Invoice {
		const taxRate = this.config.defaults.taxRate;
		const totalNet = items.reduce((sum, i) => sum + i.totalNet, 0);
		const totalTax = Math.round(totalNet * (taxRate / 100) * 100) / 100;
		const totalGross = Math.round((totalNet + totalTax) * 100) / 100;

		const issueDate = new Date().toISOString().split("T")[0];
		const dueDate = new Date(
			Date.now() + this.config.defaults.paymentTermDays * 86400000,
		)
			.toISOString()
			.split("T")[0];

		return {
			type,
			status: "draft",
			client: { name: clientName },
			items,
			currency: this.config.defaults.currency,
			issueDate,
			dueDate,
			totalNet: Math.round(totalNet * 100) / 100,
			totalTax,
			totalGross,
		};
	}
}
