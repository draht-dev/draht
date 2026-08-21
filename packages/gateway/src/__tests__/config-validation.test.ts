import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackHost } from "../cli";
import { DEFAULT_CONFIG, loadConfig, loadConfigSync } from "../config/config";

const temps: string[] = [];

/** Writes a config fixture to a temp dir and returns its path. Never ~/.draht. */
function writeConfig(contents: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "draht-gateway-config-"));
	temps.push(dir);
	const path = join(dir, "gateway.config.json");
	writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
	return path;
}

afterAll(() => {
	for (const dir of temps) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("isLoopbackHost input validation", () => {
	test.each([
		[123, "number"],
		[null, "null"],
		[undefined, "undefined"],
		[{}, "object"],
	])("rejects a non-string host (%p) with a clear error", (host) => {
		expect(() => isLoopbackHost(host as unknown as string)).toThrow(/host must be a string/);
	});
});

describe("loadConfigSync type validation", () => {
	test("rejects host: 123 with a clear error naming the field and the file", () => {
		const path = writeConfig({ host: 123 });
		expect(() => loadConfigSync(path)).toThrow(/host/);
		expect(() => loadConfigSync(path)).toThrow(/must be a string/);
		expect(() => loadConfigSync(path)).toThrow(path);
	});

	test("rejects host: null with a clear error", () => {
		const path = writeConfig({ host: null });
		expect(() => loadConfigSync(path)).toThrow(/host/);
		expect(() => loadConfigSync(path)).toThrow(/must be a string/);
	});

	test("rejects a non-numeric port and a non-object tokens map", () => {
		expect(() => loadConfigSync(writeConfig({ port: "7878" }))).toThrow(/port/);
		expect(() => loadConfigSync(writeConfig({ tokens: "nope" }))).toThrow(/tokens/);
	});

	test("accepts a valid config and keeps unknown keys harmless", () => {
		const path = writeConfig({
			$schema: "https://draht.io/gateway.schema.json",
			host: "127.0.0.1",
			port: 7878,
			tokens: { default: "t" },
			_comments: { host: "…" },
		});

		const config = loadConfigSync(path);

		expect(config.host).toBe("127.0.0.1");
		expect(config.tokens).toEqual({ default: "t" });
		expect(config.maxSessions).toBe(DEFAULT_CONFIG.maxSessions);
	});

	test("a missing file still yields the defaults", () => {
		expect(loadConfigSync(join(tmpdir(), "draht-gateway-absent", "nope.json"))).toEqual(DEFAULT_CONFIG);
	});

	test("the async loader validates identically", async () => {
		const path = writeConfig({ host: 123 });
		await expect(loadConfig(path)).rejects.toThrow(/must be a string/);
	});
});
