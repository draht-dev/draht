import { formatUserAgent } from "@draht/ai";

/** draht's `User-Agent` for its own network requests; the same detailed form @draht/ai sends to providers. */
export function getDrahtUserAgent(version: string): string {
	return formatUserAgent({ userAgent: "detailed", version });
}
