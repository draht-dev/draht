export type XMarkdownSource = "x2markdown-adapted";

export interface ConvertTweetRequest {
	url: string;
	includeThread?: boolean;
	timeoutMs?: number;
}

export interface XPostAuthor {
	name: string;
	handle: string;
}

export interface XPostPayload {
	author: XPostAuthor | null;
	time: string;
	url: string;
	body: string;
	images: string[];
	quote: XPostPayload | null;
}

export interface ConvertTweetMetadata {
	kind: "status" | "article" | "thread";
	postCount: number;
	imageCount: number;
}

export interface ConvertTweetResponse {
	url: string;
	markdown: string;
	source: XMarkdownSource;
	extractedAt: string;
	metadata: ConvertTweetMetadata;
}

export interface ConvertTweetErrorResponse {
	error: string;
	code: "bad_request" | "unauthorized" | "not_found" | "render_failed" | "unsupported_url" | "server_error";
}
