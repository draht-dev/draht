import type { XPostPayload } from "./types.js";

export interface ExtractPageOptions {
	includeThread: boolean;
	statusId: string;
}

export function extractPagePosts(options: ExtractPageOptions): XPostPayload[] {
	const articles = Array.from(document.querySelectorAll("article[data-testid='tweet']")).filter(isVisible);
	const mainIndex = findMainArticleIndex(articles, options.statusId);
	const mainArticle = articles[mainIndex] ?? articles[0];

	if (!mainArticle) {
		return [];
	}

	const mainPost = extractPost(mainArticle);
	if (!options.includeThread) {
		return [mainPost];
	}

	const threadPosts = [mainPost];
	const mainHandle = mainPost.author?.handle ?? "";

	for (const article of articles.slice(mainIndex + 1)) {
		const post = extractPost(article);
		if (!post.body && post.images.length === 0) {
			continue;
		}

		if (mainHandle && post.author?.handle && post.author.handle !== mainHandle) {
			continue;
		}

		threadPosts.push(post);
	}

	return threadPosts;
}

function findMainArticleIndex(articles: Element[], statusId: string): number {
	const index = articles.findIndex((article) => {
		return Boolean(article.querySelector(`a[href*="/status/${statusId}"]`));
	});

	return index >= 0 ? index : 0;
}

function extractPost(article: Element): XPostPayload {
	const timeElement = article.querySelector("time[datetime]");
	const tweetText = firstDirectTweetText(article);
	const quoteArticle = findQuotedArticle(article);

	return {
		author: extractAuthor(article),
		time: timeElement?.getAttribute("datetime") ?? "",
		url: extractPostUrl(article),
		body: tweetText ? extractMarkdownText(tweetText) : "",
		images: extractImages(article, quoteArticle),
		quote: quoteArticle ? extractPost(quoteArticle) : null,
	};
}

function firstDirectTweetText(article: Element): Element | null {
	const tweetTexts = Array.from(article.querySelectorAll("[data-testid='tweetText']"));
	return tweetTexts.find((element) => element.closest("article[data-testid='tweet']") === article) ?? null;
}

function findQuotedArticle(article: Element): Element | null {
	const nested = Array.from(article.querySelectorAll("article[data-testid='tweet']"));
	return nested.find((element) => element !== article) ?? null;
}

function extractAuthor(article: Element) {
	const userNameElement = article.querySelector("[data-testid='User-Name']");
	const rawLines = splitLines(userNameElement?.textContent ?? "");
	const handle = rawLines.find((line) => /^@[A-Za-z0-9_]{1,15}$/.test(line)) ?? "";
	const name = rawLines.find((line) => line !== handle && line !== "Follow" && line !== "Following") ?? "";

	if (!name && !handle) {
		return null;
	}

	return { name, handle };
}

function extractPostUrl(article: Element): string {
	const timeElement = article.querySelector("time[datetime]");
	const link = timeElement?.closest("a[href]");
	const href = link?.getAttribute("href") ?? "";

	return href ? new URL(href, window.location.href).toString() : window.location.href;
}

function extractMarkdownText(root: Element): string {
	const blocks: string[] = [];

	for (const node of root.childNodes) {
		const text = renderNode(node).trim();
		if (text) {
			blocks.push(text);
		}
	}

	return normalizeText(blocks.join("\n"));
}

function renderNode(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent ?? "";
	}

	if (!(node instanceof HTMLElement)) {
		return "";
	}

	if (node.tagName === "BR") {
		return "\n";
	}

	if (node instanceof HTMLAnchorElement && node.href) {
		const label = normalizeText(node.textContent ?? "");
		if (!label) {
			return node.href;
		}

		if (label === node.href || node.href.includes(label)) {
			return label;
		}

		return `[${label}](${node.href})`;
	}

	return Array.from(node.childNodes).map(renderNode).join("");
}

function extractImages(article: Element, quoteArticle: Element | null): string[] {
	const images = Array.from(article.querySelectorAll("img[src*='pbs.twimg.com/media']"))
		.filter((image) => quoteArticle === null || !quoteArticle.contains(image))
		.map((image) => image.getAttribute("src") ?? "")
		.filter(Boolean)
		.map(preferLargeImage);

	return Array.from(new Set(images));
}

function preferLargeImage(src: string): string {
	try {
		const url = new URL(src);
		if (url.hostname.endsWith("pbs.twimg.com")) {
			url.searchParams.set("name", "large");
		}
		return url.toString();
	} catch {
		return src;
	}
}

function isVisible(element: Element): boolean {
	if (!(element instanceof HTMLElement)) {
		return false;
	}

	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function splitLines(value: string): string[] {
	return normalizeText(value)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function normalizeText(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
