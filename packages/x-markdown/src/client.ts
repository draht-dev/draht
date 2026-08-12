import type { ConvertTweetRequest, ConvertTweetResponse } from "./types.js";

export interface XMarkdownClientOptions {
	serviceUrl: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
}

export async function convertTweetToMarkdown(
	request: ConvertTweetRequest,
	options: XMarkdownClientOptions,
): Promise<ConvertTweetResponse> {
	const fetcher = options.fetchImpl ?? fetch;
	const response = await fetcher(new URL("/convert", options.serviceUrl), {
		method: "POST",
		headers: buildHeaders(options.apiKey),
		body: JSON.stringify(request),
	});

	const payload = await response.json();
	if (!response.ok) {
		const error =
			payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "Request failed";
		throw new Error(error);
	}

	return payload as ConvertTweetResponse;
}

function buildHeaders(apiKey: string | undefined): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	if (apiKey) {
		headers.set("authorization", `Bearer ${apiKey}`);
	}
	return headers;
}
