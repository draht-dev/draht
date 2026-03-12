import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "domain-fixture");
const fixtureFiles = ["Customer.ts", "Order.ts", "OrderItem.ts", "index.ts"];
const expectedExports = [
	["Order.ts", "export interface Order"],
	["Customer.ts", "export interface Customer"],
	["OrderItem.ts", "export interface OrderItem"],
] as const;

describe("gsd domain fixture", () => {
	it("contains the expected stable fixture layout", () => {
		expect(fs.existsSync(fixtureDir)).toBe(true);
		expect(fs.readdirSync(fixtureDir).sort()).toEqual(fixtureFiles);
	});

	it("contains predictable domain terms for later codebase mapping tests", () => {
		for (const [fileName, expectedExport] of expectedExports) {
			expect(readFixture(fileName)).toContain(expectedExport);
		}

		const barrelSource = readFixture("index.ts");
		expect(barrelSource).toContain('export * from "./Order.js";');
		expect(barrelSource).toContain('export * from "./Customer.js";');
		expect(barrelSource).toContain('export * from "./OrderItem.js";');
	});
});

function readFixture(fileName: string): string {
	return fs.readFileSync(path.join(fixtureDir, fileName), "utf-8");
}
