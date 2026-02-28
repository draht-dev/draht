/**
 * Invoice line item.
 */
export interface LineItem {
	description: string;
	quantity: number;
	unitPrice: number;
	taxRate: number; // e.g. 19 for 19% German VAT
	totalNet: number;
}

/**
 * Invoice data.
 */
export interface Invoice {
	id?: string;
	number?: string;
	type: "hourly" | "fixed";
	status: "draft" | "sent" | "paid" | "overdue";
	client: {
		name: string;
		email?: string;
		address?: string;
		taxId?: string;
	};
	items: LineItem[];
	currency: string;
	issueDate: string;
	dueDate: string;
	totalNet: number;
	totalTax: number;
	totalGross: number;
	notes?: string;
	projectId?: string;
}

/**
 * Toggl time entry.
 */
export interface TimeEntry {
	id: number;
	description: string;
	start: string;
	stop: string;
	duration: number; // seconds
	project?: string;
	tags?: string[];
}

/**
 * Lexoffice API configuration.
 */
export interface LexofficeConfig {
	apiKey: string;
	baseUrl?: string;
}

/**
 * Toggl API configuration.
 */
export interface TogglConfig {
	apiToken: string;
	workspaceId: string;
}

/**
 * Invoice generator configuration.
 */
export interface InvoiceConfig {
	lexoffice?: LexofficeConfig;
	toggl?: TogglConfig;
	defaults: {
		currency: string;
		taxRate: number;
		paymentTermDays: number;
		hourlyRate?: number;
	};
}

export const DEFAULT_CONFIG: InvoiceConfig = {
	defaults: {
		currency: "EUR",
		taxRate: 19,
		paymentTermDays: 14,
		hourlyRate: 120,
	},
};
