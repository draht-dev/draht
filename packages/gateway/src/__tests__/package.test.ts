import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";

describe("package.json", () => {
	test("name is @draht/gateway", () => {
		expect(pkg.name).toBe("@draht/gateway");
	});

	test('bin["draht-gateway"] resolves to "src/cli.ts"', () => {
		expect((pkg as { bin?: Record<string, string> }).bin?.["draht-gateway"]).toBe("src/cli.ts");
	});

	test('dependencies contains "hono"', () => {
		expect(Object.keys(pkg.dependencies)).toContain("hono");
	});
});
