/** Parsing and validation for `POST /v1/bug-reports`, independent of how the parts are stored. */

export const MAX_BUG_REPORT_BYTES = 5 * 1024 * 1024;

const PART_CONTENT_TYPES: Record<string, string> = {
	"report.json": "application/json",
	"diagnostics.json": "application/json",
	"session.jsonl": "application/x-ndjson",
	"summary.md": "text/markdown",
};

const REQUIRED_PARTS = ["report.json", "diagnostics.json"] as const;

export interface BugReportPart {
	name: string;
	contentType: string;
	data: Buffer;
}

export interface ParsedBugReportRequest {
	parts: BugReportPart[];
}

export interface BugReportRequestError {
	ok: false;
	status: number;
	error: string;
	description: string;
}

export type ParseBugReportResult = { ok: true; request: ParsedBugReportRequest } | BugReportRequestError;

function fail(status: number, error: string, description: string): BugReportRequestError {
	return { ok: false, status, error, description };
}

function findHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

export interface BugReportHttpRequest {
	headers: Record<string, string | undefined>;
	body: string | undefined;
	isBase64Encoded: boolean;
}

/** Parse and validate the multipart body of a bug report upload. Pure: no network or storage access. */
export async function parseBugReportRequest(request: BugReportHttpRequest): Promise<ParseBugReportResult> {
	const contentType = findHeader(request.headers, "content-type");
	if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
		return fail(400, "invalid_content_type", "Expected a multipart/form-data request body");
	}
	if (!request.body) {
		return fail(400, "empty_body", "Request body is empty");
	}

	const bytes = Buffer.from(request.body, request.isBase64Encoded ? "base64" : "utf8");
	if (bytes.byteLength > MAX_BUG_REPORT_BYTES) {
		return fail(413, "payload_too_large", `Request body exceeds ${MAX_BUG_REPORT_BYTES} bytes`);
	}

	let formData: FormData;
	try {
		const parsedRequest = new Request("http://bug-reports.internal/v1/bug-reports", {
			method: "POST",
			headers: { "content-type": contentType },
			body: bytes,
		});
		formData = await parsedRequest.formData();
	} catch {
		return fail(400, "invalid_multipart", "Could not parse multipart/form-data body");
	}

	const parts: BugReportPart[] = [];
	const seen = new Set<string>();
	for (const [name, value] of formData.entries()) {
		const expectedContentType = PART_CONTENT_TYPES[name];
		if (!expectedContentType) {
			return fail(400, "unknown_part", `Unknown part: ${name}`);
		}
		if (!(value instanceof Blob)) {
			return fail(400, "invalid_part", `Part ${name} must be a file`);
		}
		if (value.type !== expectedContentType) {
			return fail(400, "invalid_content_type", `Part ${name} must have content type ${expectedContentType}`);
		}
		const data = Buffer.from(await value.arrayBuffer());
		if ((name === "report.json" || name === "diagnostics.json") && !isValidJson(data)) {
			return fail(400, "invalid_json", `Part ${name} is not valid JSON`);
		}
		parts.push({ name, contentType: expectedContentType, data });
		seen.add(name);
	}

	for (const required of REQUIRED_PARTS) {
		if (!seen.has(required)) {
			return fail(400, "missing_required_part", `Missing required part: ${required}`);
		}
	}

	return { ok: true, request: { parts } };
}

function isValidJson(data: Buffer): boolean {
	try {
		JSON.parse(data.toString("utf8"));
		return true;
	} catch {
		return false;
	}
}
