import type { ExtensionAPI } from "@draht/coding-agent";
import { Type } from "typebox";
import { convertTweetToMarkdown } from "./client.js";

const TOOL_PARAMS = Type.Object({
	url: Type.String({ description: "Public https://x.com/.../status/... or /article/... URL to convert." }),
	includeThread: Type.Optional(Type.Boolean({ description: "Include consecutive same-author thread replies." })),
	serviceUrl: Type.Optional(Type.String({ description: "Override X Markdown service URL." })),
	apiKey: Type.Optional(Type.String({ description: "Override bearer token for the X Markdown service." })),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Browser render timeout in milliseconds, clamped by the service." }),
	),
});

export default function xMarkdownExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "x_tweet_markdown",
		label: "X Tweet Markdown",
		description: "Convert a public X status or article URL into Markdown using the X Markdown service.",
		promptSnippet:
			"Use x_tweet_markdown to convert public X posts into Markdown before summarizing or analyzing them.",
		promptGuidelines: [
			"Use x_tweet_markdown when the user gives an x.com status or article URL and wants agent-readable content.",
			"Do not claim access to protected, deleted, paywalled, or login-gated posts.",
		],
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params, signal) {
			const serviceUrl = params.serviceUrl ?? process.env.X2MARKDOWN_SERVICE_URL;
			if (!serviceUrl) {
				throw new Error("Set X2MARKDOWN_SERVICE_URL or pass serviceUrl.");
			}

			if (signal?.aborted) {
				throw new Error("X Markdown conversion aborted.");
			}

			const result = await convertTweetToMarkdown(
				{
					url: params.url,
					includeThread: params.includeThread,
					timeoutMs: params.timeoutMs,
				},
				{
					serviceUrl,
					apiKey: params.apiKey ?? process.env.X2MARKDOWN_API_KEY,
				},
			);

			return {
				content: [{ type: "text", text: result.markdown }],
				details: result,
			};
		},
	});

	pi.registerCommand("x2md", {
		description: "Convert an X URL to Markdown: /x2md https://x.com/user/status/123",
		handler: async (args, ctx) => {
			const url = args.trim();
			if (!url) {
				ctx.ui.notify("Usage: /x2md <https://x.com/user/status/id>", "warning");
				return;
			}

			const serviceUrl = process.env.X2MARKDOWN_SERVICE_URL;
			if (!serviceUrl) {
				ctx.ui.notify("Set X2MARKDOWN_SERVICE_URL before using /x2md.", "warning");
				return;
			}

			const result = await convertTweetToMarkdown(
				{ url, includeThread: true },
				{ serviceUrl, apiKey: process.env.X2MARKDOWN_API_KEY },
			);
			ctx.ui.notify(result.markdown.slice(0, 4000), "info");
		},
	});
}
