export interface NormalizedXUrl {
	url: string;
	kind: "status" | "article";
	id: string;
}

const STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)(?:\/)?$/;
const ARTICLE_PATH = /^\/[A-Za-z0-9_]{1,15}\/article\/(\d+)(?:\/)?$/;

export function normalizeXUrl(input: string): NormalizedXUrl {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error("Expected an absolute x.com status or article URL.");
	}

	if (parsed.protocol !== "https:") {
		throw new Error("Only https://x.com URLs are supported.");
	}

	if (parsed.hostname !== "x.com") {
		throw new Error("Only x.com URLs are supported. twitter.com and mobile.x.com are intentionally rejected.");
	}

	const statusMatch = parsed.pathname.match(STATUS_PATH);
	if (statusMatch) {
		return {
			url: cleanUrl(parsed),
			kind: "status",
			id: statusMatch[1],
		};
	}

	const articleMatch = parsed.pathname.match(ARTICLE_PATH);
	if (articleMatch) {
		return {
			url: cleanUrl(parsed),
			kind: "article",
			id: articleMatch[1],
		};
	}

	throw new Error("Expected a URL like https://x.com/user/status/123 or https://x.com/user/article/123.");
}

function cleanUrl(url: URL): string {
	url.hash = "";
	url.search = "";
	return url.toString();
}
