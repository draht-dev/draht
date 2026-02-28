/**
 * Coding agent extension for client knowledge base.
 * Auto-loads client context on session start, provides /knowledge commands.
 */

import type { ExtensionFactory } from "@draht/coding-agent";
import { loadClientConfig } from "./client-config.js";
import { KnowledgeManager, type SearchMode } from "./knowledge-manager.js";

export const knowledgeExtension: ExtensionFactory = (pi) => {
	let manager: KnowledgeManager | null = null;
	let clientName = "";

	pi.on("session_start", async (_event, ctx) => {
		const config = loadClientConfig(ctx.cwd);
		if (!config) return;

		try {
			manager = new KnowledgeManager(config.slug);
			clientName = config.name;

			// Auto-index AGENTS.md if present
			if (config.agentsMdPath) {
				await manager.indexFile(config.agentsMdPath);
			}

			ctx.ui.notify(`Knowledge base loaded for client: ${config.name}`, "info");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Knowledge base init failed: ${msg}`, "warning");
			manager = null;
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!manager) return;

		try {
			const results = await manager.searchKnowledge(event.prompt, "general", 3);
			if (results.length === 0) return;

			const knowledgeBlock = formatKnowledgeForPrompt(results, clientName);
			return {
				systemPrompt: `${event.systemPrompt}\n\n${knowledgeBlock}`,
			};
		} catch {
			// Silently skip knowledge injection on errors
			return;
		}
	});

	pi.on("session_shutdown", async () => {
		manager?.close();
		manager = null;
	});

	pi.registerCommand("knowledge", {
		description: "Manage client knowledge base: index, search, forget, status",
		handler: async (args, ctx) => {
			if (!manager) {
				ctx.ui.notify("No knowledge base active. Create .draht/client.json or add AGENTS.md to cwd.", "warning");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "status";
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "index": {
					const target = rest || ctx.cwd;
					try {
						const count = target.endsWith("/")
							? await manager.indexDirectory(target)
							: await manager.indexFile(target);
						ctx.ui.notify(`Indexed ${count} new chunks from: ${target}`, "info");
					} catch (error) {
						ctx.ui.notify(`Index failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					break;
				}
				case "search": {
					if (!rest) {
						ctx.ui.notify("Usage: /knowledge search <query> [mode]", "warning");
						return;
					}
					// Check for mode suffix: "query --mode decide"
					const modeMatch = rest.match(/\s+--mode\s+(decide|connect|fuzzy|general)$/);
					const mode = (modeMatch?.[1] as SearchMode) ?? "general";
					const query = modeMatch ? rest.slice(0, modeMatch.index) : rest;

					const results = await manager.searchKnowledge(query, mode, 5);
					if (results.length === 0) {
						ctx.ui.notify("No results found.", "info");
						return;
					}
					const formatted = results
						.map((r, i) => `${i + 1}. [${r.score.toFixed(3)}] (${r.metadata.source})\n   ${r.content.slice(0, 120)}...`)
						.join("\n\n");
					ctx.ui.notify(formatted, "info");
					break;
				}
				case "forget": {
					if (!rest) {
						ctx.ui.notify("Usage: /knowledge forget <source-file>", "warning");
						return;
					}
					const deleted = await manager.forget(rest);
					ctx.ui.notify(`Removed ${deleted} chunks from: ${rest}`, "info");
					break;
				}
				case "status": {
					const stats = manager.getStats();
					ctx.ui.notify(
						`Knowledge Base: ${stats.clientSlug}\nChunks: ${stats.totalChunks}\nSources: ${stats.sources.length}\n${stats.sources.map((s) => `  - ${s}`).join("\n")}`,
						"info",
					);
					break;
				}
				default:
					ctx.ui.notify("Usage: /knowledge [index|search|forget|status]", "info");
			}
		},
	});
};

function formatKnowledgeForPrompt(results: Array<{ content: string; metadata: { source: string; type: string }; score: number }>, clientName: string): string {
	const items = results
		.filter((r) => r.score > 0.3)
		.map((r) => `<item source="${r.metadata.source}" type="${r.metadata.type}" relevance="${r.score.toFixed(2)}">\n${r.content}\n</item>`)
		.join("\n");

	if (!items) return "";

	return `<client_knowledge client="${clientName}">
${items}
</client_knowledge>`;
}
