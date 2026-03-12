import type { Customer } from "./Customer.js";
import type { OrderItem } from "./OrderItem.js";

export interface Order {
	id: string;
	customer: Customer;
	items: OrderItem[];
	totalCents: number;
}
