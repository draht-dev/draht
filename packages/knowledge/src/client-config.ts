/**
 * Client configuration and namespace management.
 * Each client gets an isolated knowledge directory under ~/.draht/knowledge/{slug}/.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClientConfig {
	slug: string;
	name: string;
	agentsMdPath?: string;
	watchPaths?: string[];
}

/**
 * Load client config from cwd.
 * Checks .draht/client.json first, then falls back to AGENTS.md extraction.
 */
export function loadClientConfig(cwd: string): ClientConfig | null {
	// Try .draht/client.json
	const configPath = path.join(cwd, ".draht", "client.json");
	if (fs.existsSync(configPath)) {
		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const config = JSON.parse(raw) as Partial<ClientConfig>;
			if (config.slug && config.name) {
				return {
					slug: config.slug,
					name: config.name,
					agentsMdPath: config.agentsMdPath ?? findAgentsMd(cwd),
					watchPaths: config.watchPaths,
				};
			}
		} catch {
			// Invalid JSON, fall through
		}
	}

	// Try AGENTS.md extraction
	const agentsMdPath = findAgentsMd(cwd);
	if (agentsMdPath) {
		const slug = slugifyPath(cwd);
		return {
			slug,
			name: path.basename(cwd),
			agentsMdPath,
		};
	}

	return null;
}

/**
 * Get the knowledge store directory for a client.
 */
export function getKnowledgePath(slug: string): string {
	return path.join(os.homedir(), ".draht", "knowledge", slug);
}

/**
 * Get the database file path for a client's knowledge store.
 */
export function getKnowledgeDbPath(slug: string): string {
	return path.join(getKnowledgePath(slug), "vectors.db");
}

function findAgentsMd(cwd: string): string | undefined {
	const candidates = ["AGENTS.md", ".agents/AGENTS.md", "docs/AGENTS.md"];
	for (const candidate of candidates) {
		const full = path.join(cwd, candidate);
		if (fs.existsSync(full)) return full;
	}
	return undefined;
}

function slugifyPath(cwd: string): string {
	return path
		.basename(cwd)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}
