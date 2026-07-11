import { afterEach, describe, expect, test } from "bun:test";
import { TogglClient } from "../src/toggl.js";
import type { TimeEntry } from "../src/types.js";

const originalFetch = globalThis.fetch;

const config = { apiToken: "test-token-123", workspaceId: "ws-1" };

describe("TogglClient", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("getTimeEntries includes date-range query params and returns the array unchanged", async () => {
		const entries: TimeEntry[] = [
			{
				id: 1,
				description: "Development",
				start: "2026-01-01T09:00:00Z",
				stop: "2026-01-01T10:00:00Z",
				duration: 3600,
			},
			{
				id: 2,
				description: "Review",
				start: "2026-01-02T09:00:00Z",
				stop: "2026-01-02T09:30:00Z",
				duration: 1800,
			},
		];
		let capturedUrl: string | undefined;
		globalThis.fetch = (async (url: RequestInfo | URL) => {
			capturedUrl = url.toString();
			return new Response(JSON.stringify(entries), { status: 200 });
		}) as typeof fetch;

		const client = new TogglClient(config);
		const result = await client.getTimeEntries("2026-01-01", "2026-01-31");

		expect(capturedUrl).toContain("start_date=2026-01-01");
		expect(capturedUrl).toContain("end_date=2026-01-31");
		expect(result).toEqual(entries);
	});

	test("sends a Basic auth header encoding <apiToken>:api_token", async () => {
		let capturedHeaders: Record<string, string> | undefined;
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			capturedHeaders = init?.headers as Record<string, string>;
			return new Response(JSON.stringify([]), { status: 200 });
		}) as typeof fetch;

		const client = new TogglClient(config);
		await client.getTimeEntries("2026-01-01", "2026-01-31");

		const authHeader = capturedHeaders?.Authorization;
		expect(authHeader).toMatch(/^Basic /);
		const decoded = Buffer.from(authHeader!.replace("Basic ", ""), "base64").toString("utf-8");
		expect(decoded).toBe(`${config.apiToken}:api_token`);
	});

	test("getProjectTime filters entries by project name case-insensitively", async () => {
		const entries: TimeEntry[] = [
			{ id: 1, description: "A", start: "", stop: "", duration: 3600, project: "Client A" },
			{ id: 2, description: "B", start: "", stop: "", duration: 1800, project: "client a" },
			{ id: 3, description: "C", start: "", stop: "", duration: 900, project: "Client B" },
		];
		globalThis.fetch = (async () => new Response(JSON.stringify(entries), { status: 200 })) as typeof fetch;

		const client = new TogglClient(config);
		const result = await client.getProjectTime("client A", "2026-01-01", "2026-01-31");

		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((e) => e.id).sort()).toEqual([1, 2]);
	});

	test("getProjectTime rounds totalHours to 2 decimal places", async () => {
		const entries: TimeEntry[] = [
			{ id: 1, description: "A", start: "", stop: "", duration: 5000, project: "Client A" },
			{ id: 2, description: "B", start: "", stop: "", duration: 3200, project: "Client A" },
			{ id: 3, description: "C", start: "", stop: "", duration: 999, project: "Other" },
		];
		globalThis.fetch = (async () => new Response(JSON.stringify(entries), { status: 200 })) as typeof fetch;

		const client = new TogglClient(config);
		const result = await client.getProjectTime("Client A", "2026-01-01", "2026-01-31");

		// (5000 + 3200) / 3600 = 2.27777... -> rounds to 2.28
		expect(result.totalHours).toBe(2.28);
	});

	test("getTimeEntries rejects with an Error including the status code and body text on a non-2xx response", async () => {
		globalThis.fetch = (async () => new Response("Invalid API token", { status: 401 })) as typeof fetch;

		const client = new TogglClient(config);
		await expect(client.getTimeEntries("2026-01-01", "2026-01-31")).rejects.toThrow(/401/);
		await expect(client.getTimeEntries("2026-01-01", "2026-01-31")).rejects.toThrow(/Invalid API token/);
	});
});
