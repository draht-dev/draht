import { convertTweetWithBrowser, type WorkerEnv } from "./browser.js";
import type { ConvertTweetErrorResponse, ConvertTweetRequest } from "./types.js";
import { normalizeXUrl } from "./url.js";

const JSON_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "authorization,content-type",
	"content-type": "application/json; charset=utf-8",
};

const worker = {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: JSON_HEADERS });
		}

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return json({ ok: true, service: "x-markdown" });
		}

		if (request.method !== "POST" || url.pathname !== "/convert") {
			return jsonError(404, "not_found", "Use POST /convert.");
		}

		if (!isAuthorized(request, env)) {
			return jsonError(401, "unauthorized", "Missing or invalid bearer token.");
		}

		let payload: ConvertTweetRequest;
		try {
			payload = await request.json();
		} catch {
			return jsonError(400, "bad_request", "Expected a JSON request body.");
		}

		if (!payload || typeof payload.url !== "string") {
			return jsonError(400, "bad_request", "Expected body with a string url field.");
		}

		try {
			normalizeXUrl(payload.url);
		} catch (error) {
			return jsonError(400, "unsupported_url", error instanceof Error ? error.message : "Unsupported X URL.");
		}

		try {
			const result = await convertTweetWithBrowser(env, payload);
			return json(result);
		} catch (error) {
			return jsonError(502, "render_failed", error instanceof Error ? error.message : "Browser rendering failed.");
		}
	},
};

export default worker;
export const handler = worker;

function isAuthorized(request: Request, env: WorkerEnv): boolean {
	if (!env.X2MARKDOWN_API_KEY) {
		return true;
	}

	return request.headers.get("authorization") === `Bearer ${env.X2MARKDOWN_API_KEY}`;
}

function json(payload: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		...init,
		headers: JSON_HEADERS,
	});
}

function jsonError(status: number, code: ConvertTweetErrorResponse["code"], error: string): Response {
	return json({ code, error } satisfies ConvertTweetErrorResponse, { status });
}
