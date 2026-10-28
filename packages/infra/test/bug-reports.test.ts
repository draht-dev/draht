import { describe, expect, it } from "vitest";
import { handleBugReportUpload } from "../src/functions/bug-reports/core.ts";
import { MAX_BUG_REPORT_BYTES } from "../src/functions/bug-reports/request.ts";

interface HttpRequestInit {
	headers: Record<string, string | undefined>;
	body: string | undefined;
	isBase64Encoded: boolean;
}

async function buildMultipartRequest(
	parts: Array<{ name: string; contentType: string; data: string }>,
	options: { base64?: boolean } = {},
): Promise<HttpRequestInit> {
	const formData = new FormData();
	for (const part of parts) {
		formData.append(part.name, new Blob([part.data], { type: part.contentType }), part.name);
	}
	const encodedRequest = new Request("http://localhost/v1/bug-reports", { method: "POST", body: formData });
	const contentType = encodedRequest.headers.get("content-type") ?? "";
	const bytes = Buffer.from(await encodedRequest.arrayBuffer());
	return {
		headers: { "content-type": contentType },
		body: options.base64 ? bytes.toString("base64") : bytes.toString("utf8"),
		isBase64Encoded: options.base64 ?? false,
	};
}

const REPORT_JSON = JSON.stringify({ schemaVersion: 1, id: "abc" });
const DIAGNOSTICS_JSON = JSON.stringify({ schemaVersion: 1, entryCount: 0 });

function validParts() {
	return [
		{ name: "report.json", contentType: "application/json", data: REPORT_JSON },
		{ name: "diagnostics.json", contentType: "application/json", data: DIAGNOSTICS_JSON },
	];
}

function deps() {
	const stored = new Map<string, { contentType: string; data: Buffer }>();
	return {
		stored,
		deps: {
			putObject: async (key: string, part: { contentType: string; data: Buffer }) => {
				stored.set(key, { contentType: part.contentType, data: part.data });
			},
			randomId: () => "11111111-1111-1111-1111-111111111111",
			now: () => new Date("2026-10-01T00:00:00.000Z"),
		},
	};
}

describe("handleBugReportUpload", () => {
	it("stores required and optional parts under reports/<date>/<id>/<name>", async () => {
		const request = await buildMultipartRequest([
			...validParts(),
			{ name: "session.jsonl", contentType: "application/x-ndjson", data: '{"a":1}\n' },
			{ name: "summary.md", contentType: "text/markdown", data: "# Summary\n" },
		]);
		const { stored, deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({
			ok: true,
			bug_report: { id: "11111111-1111-1111-1111-111111111111" },
		});
		expect([...stored.keys()].sort()).toEqual(
			[
				"reports/2026-10-01/11111111-1111-1111-1111-111111111111/report.json",
				"reports/2026-10-01/11111111-1111-1111-1111-111111111111/diagnostics.json",
				"reports/2026-10-01/11111111-1111-1111-1111-111111111111/session.jsonl",
				"reports/2026-10-01/11111111-1111-1111-1111-111111111111/summary.md",
			].sort(),
		);
	});

	it("accepts a base64-encoded body", async () => {
		const request = await buildMultipartRequest(validParts(), { base64: true });
		const { stored, deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(200);
		expect(stored.size).toBe(2);
	});

	it("rejects a request missing a required part", async () => {
		const request = await buildMultipartRequest([
			{ name: "report.json", contentType: "application/json", data: REPORT_JSON },
		]);
		const { deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: "missing_required_part" });
	});

	it("rejects an unknown part name", async () => {
		const request = await buildMultipartRequest([
			...validParts(),
			{ name: "secrets.env", contentType: "text/plain", data: "API_KEY=abc" },
		]);
		const { deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: "unknown_part" });
	});

	it("rejects invalid JSON in report.json", async () => {
		const request = await buildMultipartRequest([
			{ name: "report.json", contentType: "application/json", data: "{not json" },
			{ name: "diagnostics.json", contentType: "application/json", data: DIAGNOSTICS_JSON },
		]);
		const { deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: "invalid_json" });
	});

	it("rejects a body over the 5 MiB cap", async () => {
		const oversized = "x".repeat(MAX_BUG_REPORT_BYTES + 1);
		const request = await buildMultipartRequest([
			{ name: "report.json", contentType: "application/json", data: REPORT_JSON },
			{ name: "diagnostics.json", contentType: "application/json", data: DIAGNOSTICS_JSON },
			{ name: "summary.md", contentType: "text/markdown", data: oversized },
		]);
		const { deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(413);
		expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: "payload_too_large" });
	});

	it("never forwards the Authorization header to storage", async () => {
		const request = await buildMultipartRequest(validParts());
		request.headers.authorization = "Bearer super-secret";
		const { stored, deps: d } = deps();

		const response = await handleBugReportUpload(request, d);

		expect(response.statusCode).toBe(200);
		for (const part of stored.values()) {
			expect(part.data.toString("utf8")).not.toContain("super-secret");
		}
	});
});
