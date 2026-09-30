import { describe, expect, it } from "vitest";
import { getDrahtUserAgent } from "../src/utils/draht-user-agent.ts";

describe("getDrahtUserAgent", () => {
	it("formats the draht user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getDrahtUserAgent("1.2.3");

		expect(userAgent).toBe(`draht/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^draht\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
