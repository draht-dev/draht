import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { extractPagePosts } from "./extract-page.js";
import { buildMarkdown } from "./markdown.js";
import type { ConvertTweetRequest, ConvertTweetResponse } from "./types.js";
import { normalizeXUrl } from "./url.js";

export interface WorkerEnv {
	BROWSER?: BrowserWorker;
	X2MARKDOWN_API_KEY?: string;
}

export async function convertTweetWithBrowser(
	env: WorkerEnv,
	request: ConvertTweetRequest,
): Promise<ConvertTweetResponse> {
	const normalized = normalizeXUrl(request.url);
	const timeoutMs = clampTimeout(request.timeoutMs);

	if (!env.BROWSER) {
		throw new Error("Cloudflare Browser Rendering binding BROWSER is not configured.");
	}

	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(timeoutMs);
		page.setDefaultNavigationTimeout(timeoutMs);

		await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
		await page.goto(normalized.url, { waitUntil: "networkidle2", timeout: timeoutMs });
		await page.waitForSelector("article[data-testid='tweet']", { timeout: Math.min(timeoutMs, 15_000) });

		const posts = await page.evaluate(extractPagePosts, {
			includeThread: Boolean(request.includeThread),
			statusId: normalized.id,
		});
		const result = buildMarkdown(posts, normalized.url, normalized.kind);

		return {
			url: normalized.url,
			markdown: result.markdown,
			source: "x2markdown-adapted",
			extractedAt: new Date().toISOString(),
			metadata: result.metadata,
		};
	} finally {
		await browser.close();
	}
}

function clampTimeout(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 30_000;
	}

	return Math.min(Math.max(Math.trunc(value), 5_000), 60_000);
}
