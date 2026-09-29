import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import stubProviderExtension from "./stub-provider/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "stub-provider", factory: stubProviderExtension, hidden: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, hidden: true, replaceable: true },
	{ name: "tool-search", factory: toolSearchExtension, hidden: true, replaceable: true },
	{ name: "mcp", factory: mcpExtension, hidden: true, replaceable: true },
];
