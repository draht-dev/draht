import { type BugReportHttpRequest, type BugReportPart, parseBugReportRequest } from "./request.ts";

export interface BugReportResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}

export interface BugReportUploadDeps {
	putObject: (key: string, part: BugReportPart) => Promise<void>;
	randomId?: () => string;
	now?: () => Date;
}

function jsonResponse(statusCode: number, body: unknown): BugReportResponse {
	return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function dateStamp(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Validate and store a `POST /v1/bug-reports` upload. The S3 write is injected for testability. */
export async function handleBugReportUpload(
	request: BugReportHttpRequest,
	deps: BugReportUploadDeps,
): Promise<BugReportResponse> {
	const parsed = await parseBugReportRequest(request);
	if (!parsed.ok) {
		return jsonResponse(parsed.status, { ok: false, error: parsed.error, description: parsed.description });
	}

	const id = (deps.randomId ?? (() => crypto.randomUUID()))();
	const prefix = `reports/${dateStamp((deps.now ?? (() => new Date()))())}/${id}`;
	await Promise.all(parsed.request.parts.map((part) => deps.putObject(`${prefix}/${part.name}`, part)));

	return jsonResponse(200, { ok: true, bug_report: { id } });
}
