import type { ConvertTweetMetadata, XPostAuthor, XPostPayload } from "./types.js";

export interface MarkdownResult {
	markdown: string;
	metadata: ConvertTweetMetadata;
}

export function buildMarkdown(posts: XPostPayload[], url: string, kind: "status" | "article"): MarkdownResult {
	const visiblePosts = posts.filter((post) => post.body || post.images.length > 0 || post.quote);
	const firstPost = visiblePosts[0];

	if (!firstPost) {
		throw new Error("No readable X post content found on the page.");
	}

	if (visiblePosts.length > 1) {
		const markdown = buildThreadMarkdown(visiblePosts, url);
		return {
			markdown,
			metadata: {
				kind: "thread",
				postCount: visiblePosts.length,
				imageCount: countImages(visiblePosts),
			},
		};
	}

	return {
		markdown: buildSinglePostMarkdown(firstPost, url),
		metadata: {
			kind,
			postCount: 1,
			imageCount: countImages(visiblePosts),
		},
	};
}

function buildThreadMarkdown(posts: XPostPayload[], url: string): string {
	const firstPost = posts[0];
	const lines: string[] = [];
	const author = formatAuthor(firstPost.author) || "Unknown author";

	lines.push(`Author: ${author}`);
	if (firstPost.time) {
		lines.push(`Time: ${firstPost.time}`);
	}
	lines.push(`Link: ${url}`, "", "Body:", renderThreadBody(posts));

	return lines.join("\n").trim();
}

function buildSinglePostMarkdown(post: XPostPayload, fallbackUrl: string): string {
	const lines: string[] = [];
	const author = formatAuthor(post.author) || "Unknown author";

	lines.push(`Author: ${author}`);
	if (post.time) {
		lines.push(`Time: ${post.time}`);
	}
	lines.push(`Link: ${post.url || fallbackUrl}`, "", "Body:", post.body);
	appendQuote(lines, post.quote);
	appendImages(lines, post.images, "Images", "Image");

	return lines.join("\n").trim();
}

function renderThreadBody(posts: XPostPayload[]): string {
	return posts
		.map((post) => renderThreadPost(post))
		.filter(Boolean)
		.join("\n\n---\n\n")
		.trim();
}

function renderThreadPost(post: XPostPayload): string {
	const lines = post.body ? [post.body] : [];

	appendQuote(lines, post.quote);
	appendImages(lines, post.images, "Images", "Image");

	return lines.join("\n").trim();
}

function appendQuote(lines: string[], quote: XPostPayload | null): void {
	if (!quote || !quote.body) {
		return;
	}

	lines.push("", "Quoted Post:");
	const author = formatAuthor(quote.author);
	if (author) {
		lines.push(`Author: ${author}`);
	}
	if (quote.time) {
		lines.push(`Time: ${quote.time}`);
	}
	if (quote.url) {
		lines.push(`Link: ${quote.url}`);
	}

	lines.push("Body:");
	lines.push(
		quote.body
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n"),
	);

	appendImages(lines, quote.images, "Quoted Images", "Quoted Image");
}

function appendImages(lines: string[], images: string[], sectionLabel: string, imageLabel: string): void {
	if (images.length === 0) {
		return;
	}

	lines.push("", `${sectionLabel}:`);
	for (const [index, imageUrl] of images.entries()) {
		lines.push(`- [${imageLabel} ${index + 1}](${imageUrl})`);
	}
}

function formatAuthor(author: XPostAuthor | null): string {
	if (!author) {
		return "";
	}

	if (author.name && author.handle) {
		return `${author.name} (${author.handle})`;
	}

	return author.name || author.handle;
}

function countImages(posts: XPostPayload[]): number {
	return posts.reduce((total, post) => total + post.images.length + (post.quote?.images.length ?? 0), 0);
}
