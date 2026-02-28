/**
 * Knowledge manager — high-level API for client knowledge operations.
 * Wraps VectorStore with chunking, file indexing, and search modes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getKnowledgeDbPath } from "./client-config.js";
import { type Chunk, type ChunkMetadata, type ChunkType, type SearchResult, VectorStore } from "./vector-store.js";

export type SearchMode = "decide" | "connect" | "fuzzy" | "general";

export class KnowledgeManager {
	private store: VectorStore;
	private clientSlug: string;

	constructor(clientSlug: string, openaiApiKey?: string) {
		const apiKey = openaiApiKey ?? process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY required for knowledge base embeddings");
		}
		this.clientSlug = clientSlug;
		this.store = new VectorStore(getKnowledgeDbPath(clientSlug), apiKey);
	}

	/**
	 * Index a file into the knowledge base.
	 * Chunks by headings/paragraphs, deduplicates via content hash.
	 */
	async indexFile(filePath: string): Promise<number> {
		const absPath = path.resolve(filePath);
		if (!fs.existsSync(absPath)) {
			throw new Error(`File not found: ${absPath}`);
		}

		const content = fs.readFileSync(absPath, "utf-8");
		const chunks = chunkContent(content, {
			source: absPath,
			client: this.clientSlug,
			timestamp: Date.now(),
			type: inferChunkType(absPath),
		});

		return this.store.index(chunks);
	}

	/**
	 * Index a directory recursively (markdown files only).
	 */
	async indexDirectory(dirPath: string): Promise<number> {
		const absDir = path.resolve(dirPath);
		if (!fs.existsSync(absDir)) {
			throw new Error(`Directory not found: ${absDir}`);
		}

		let total = 0;
		const entries = fs.readdirSync(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(absDir, entry.name);
			if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
				total += await this.indexDirectory(full);
			} else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
				total += await this.indexFile(full);
			}
		}
		return total;
	}

	/**
	 * Search knowledge with optional mode for query refinement.
	 */
	async searchKnowledge(query: string, mode: SearchMode = "general", limit = 5): Promise<SearchResult[]> {
		const refinedQuery = refineQueryByMode(query, mode);
		return this.store.search(refinedQuery, limit);
	}

	/**
	 * Remove all knowledge from a specific source file.
	 */
	async forget(sourceFile: string): Promise<number> {
		return this.store.delete(path.resolve(sourceFile));
	}

	/**
	 * Get knowledge base statistics.
	 */
	getStats(): { totalChunks: number; sources: string[]; clientSlug: string } {
		const stats = this.store.getStats();
		return { ...stats, clientSlug: this.clientSlug };
	}

	close(): void {
		this.store.close();
	}
}

// ============================================================================
// Chunking
// ============================================================================

const MAX_CHUNK_CHARS = 2000; // ~500 tokens

function chunkContent(content: string, baseMetadata: ChunkMetadata): Chunk[] {
	const chunks: Chunk[] = [];

	// Split by markdown headings
	const sections = content.split(/^(?=#{1,3}\s)/m);

	for (const section of sections) {
		const trimmed = section.trim();
		if (!trimmed) continue;

		if (trimmed.length <= MAX_CHUNK_CHARS) {
			chunks.push({ content: trimmed, metadata: { ...baseMetadata } });
		} else {
			// Split long sections by paragraphs
			const paragraphs = trimmed.split(/\n\n+/);
			let current = "";
			for (const para of paragraphs) {
				if (current.length + para.length + 2 > MAX_CHUNK_CHARS) {
					if (current.trim()) {
						chunks.push({ content: current.trim(), metadata: { ...baseMetadata } });
					}
					current = para;
				} else {
					current = current ? `${current}\n\n${para}` : para;
				}
			}
			if (current.trim()) {
				chunks.push({ content: current.trim(), metadata: { ...baseMetadata } });
			}
		}
	}

	return chunks;
}

function inferChunkType(filePath: string): ChunkType {
	const basename = path.basename(filePath).toLowerCase();
	if (basename.includes("agents") || basename.includes("convention")) return "convention";
	if (basename.includes("decision") || basename.includes("adr")) return "decision";
	if (basename.includes("pattern")) return "pattern";
	return "general";
}

function refineQueryByMode(query: string, mode: SearchMode): string {
	switch (mode) {
		case "decide":
			return `decisions and choices about: ${query}`;
		case "connect":
			return `relationships and connections related to: ${query}`;
		case "fuzzy":
			return query; // Use as-is for fuzzy/vague queries
		default:
			return query;
	}
}
