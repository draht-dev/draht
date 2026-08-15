#!/usr/bin/env bun
/**
 * x-markdown CLI — convert a public X status or article URL into Markdown
 * via the X Markdown service.
 *
 * Usage:
 *   x-markdown <https://x.com/user/status/id> [options]
 *
 * Options:
 *   --thread              Include consecutive same-author thread replies
 *   --service-url <url>   X Markdown service URL (default: $X2MARKDOWN_SERVICE_URL)
 *   --api-key <key>       Bearer token (default: $X2MARKDOWN_API_KEY)
 *   --timeout <ms>        Browser render timeout in milliseconds
 *   --json                Print the full JSON response instead of Markdown
 *   -h, --help            Show this help
 */
import { convertTweetToMarkdown } from "./client.js";

const HELP = `Usage: x-markdown <https://x.com/user/status/id> [options]

Convert a public X status or article URL into Markdown via the X Markdown service.

Options:
  --thread              Include consecutive same-author thread replies
  --service-url <url>   X Markdown service URL (default: $X2MARKDOWN_SERVICE_URL)
  --api-key <key>       Bearer token (default: $X2MARKDOWN_API_KEY)
  --timeout <ms>        Browser render timeout in milliseconds
  --json                Print the full JSON response instead of Markdown
  -h, --help            Show this help`;

interface CliOptions {
	url: string;
	includeThread: boolean;
	serviceUrl: string | undefined;
	apiKey: string | undefined;
	timeoutMs: number | undefined;
	json: boolean;
}

function parseArgs(argv: string[]): CliOptions | "help" {
	let url: string | undefined;
	let includeThread = false;
	let serviceUrl: string | undefined;
	let apiKey: string | undefined;
	let timeoutMs: number | undefined;
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				return "help";
			case "--thread":
				includeThread = true;
				break;
			case "--json":
				json = true;
				break;
			case "--service-url":
				serviceUrl = argv[++i];
				if (!serviceUrl) throw new Error("--service-url requires a value");
				break;
			case "--api-key":
				apiKey = argv[++i];
				if (!apiKey) throw new Error("--api-key requires a value");
				break;
			case "--timeout": {
				const value = argv[++i];
				if (!value) throw new Error("--timeout requires a value");
				timeoutMs = Number(value);
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
					throw new Error(`Invalid --timeout value: ${value}`);
				}
				break;
			}
			default:
				if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
				if (url) throw new Error("Only one URL is supported");
				url = arg;
		}
	}

	if (!url) throw new Error("Missing X URL. Run x-markdown --help for usage.");
	return { url, includeThread, serviceUrl, apiKey, timeoutMs, json };
}

async function main(): Promise<void> {
	let options: CliOptions | "help";
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	if (options === "help") {
		console.log(HELP);
		return;
	}

	const serviceUrl = options.serviceUrl ?? process.env.X2MARKDOWN_SERVICE_URL;
	if (!serviceUrl) {
		console.error("Set X2MARKDOWN_SERVICE_URL or pass --service-url.");
		process.exit(1);
	}

	try {
		const result = await convertTweetToMarkdown(
			{
				url: options.url,
				includeThread: options.includeThread,
				timeoutMs: options.timeoutMs,
			},
			{
				serviceUrl,
				apiKey: options.apiKey ?? process.env.X2MARKDOWN_API_KEY,
			},
		);
		console.log(options.json ? JSON.stringify(result, null, 2) : result.markdown);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

await main();
