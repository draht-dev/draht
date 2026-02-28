/**
 * Vector store backed by SQLite with OpenAI embeddings.
 * Provides local-first semantic search per client namespace.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

// ============================================================================
// Types
// ============================================================================

export type ChunkType = "decision" | "convention" | "pattern" | "general";

export interface ChunkMetadata {
	source: string;
	client: string;
	timestamp: number;
	type: ChunkType;
}

export interface Chunk {
	content: string;
	metadata: ChunkMetadata;
}

export interface SearchResult {
	content: string;
	metadata: ChunkMetadata;
	score: number;
}

// ============================================================================
// Embedding
// ============================================================================

async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
	const response = await fetch("https://api.openai.com/v1/embeddings", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "text-embedding-3-small",
			input: text,
		}),
	});

	if (!response.ok) {
		throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
	return data.data[0].embedding;
}

async function getEmbeddingsBatch(texts: string[], apiKey: string): Promise<number[][]> {
	if (texts.length === 0) return [];
	if (texts.length === 1) return [await getEmbedding(texts[0], apiKey)];

	const response = await fetch("https://api.openai.com/v1/embeddings", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "text-embedding-3-small",
			input: texts,
		}),
	});

	if (!response.ok) {
		throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
	// Sort by index to maintain order
	return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function embeddingToBuffer(embedding: number[]): Buffer {
	const buf = Buffer.alloc(embedding.length * 4);
	for (let i = 0; i < embedding.length; i++) {
		buf.writeFloatLE(embedding[i], i * 4);
	}
	return buf;
}

function bufferToEmbedding(buf: Buffer): number[] {
	const result: number[] = [];
	for (let i = 0; i < buf.length; i += 4) {
		result.push(buf.readFloatLE(i));
	}
	return result;
}

// ============================================================================
// VectorStore
// ============================================================================

export class VectorStore {
	private db: Database.Database;
	private apiKey: string;

	constructor(dbPath: string, openaiApiKey: string) {
		this.apiKey = openaiApiKey;

		// Ensure directory exists
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				content TEXT NOT NULL,
				embedding BLOB NOT NULL,
				source TEXT NOT NULL,
				client TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				type TEXT NOT NULL DEFAULT 'general',
				content_hash TEXT NOT NULL UNIQUE
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
			CREATE INDEX IF NOT EXISTS idx_chunks_client ON chunks(client);
			CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
		`);
	}

	async index(chunks: Chunk[]): Promise<number> {
		if (chunks.length === 0) return 0;

		// Filter out duplicates by content hash
		const existingHashes = new Set<string>();
		const checkStmt = this.db.prepare("SELECT 1 FROM chunks WHERE content_hash = ?");
		const newChunks: Array<Chunk & { hash: string }> = [];

		for (const chunk of chunks) {
			const hash = contentHash(chunk.content);
			if (existingHashes.has(hash)) continue;
			const exists = checkStmt.get(hash);
			if (exists) {
				existingHashes.add(hash);
				continue;
			}
			newChunks.push({ ...chunk, hash });
			existingHashes.add(hash);
		}

		if (newChunks.length === 0) return 0;

		// Batch embed
		const embeddings = await getEmbeddingsBatch(
			newChunks.map((c) => c.content),
			this.apiKey,
		);

		// Insert
		const insertStmt = this.db.prepare(
			"INSERT OR IGNORE INTO chunks (content, embedding, source, client, timestamp, type, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);

		const insertMany = this.db.transaction(() => {
			let inserted = 0;
			for (let i = 0; i < newChunks.length; i++) {
				const chunk = newChunks[i];
				const result = insertStmt.run(
					chunk.content,
					embeddingToBuffer(embeddings[i]),
					chunk.metadata.source,
					chunk.metadata.client,
					chunk.metadata.timestamp,
					chunk.metadata.type,
					chunk.hash,
				);
				if (result.changes > 0) inserted++;
			}
			return inserted;
		});

		return insertMany();
	}

	async search(query: string, limit = 5): Promise<SearchResult[]> {
		const queryEmbedding = await getEmbedding(query, this.apiKey);
		const rows = this.db
			.prepare("SELECT content, embedding, source, client, timestamp, type FROM chunks")
			.all() as Array<{
			content: string;
			embedding: Buffer;
			source: string;
			client: string;
			timestamp: number;
			type: ChunkType;
		}>;

		const scored = rows.map((row) => ({
			content: row.content,
			metadata: {
				source: row.source,
				client: row.client,
				timestamp: row.timestamp,
				type: row.type,
			},
			score: cosineSimilarity(queryEmbedding, bufferToEmbedding(row.embedding)),
		}));

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	async delete(sourceFile: string): Promise<number> {
		const result = this.db.prepare("DELETE FROM chunks WHERE source = ?").run(sourceFile);
		return result.changes;
	}

	getStats(): { totalChunks: number; sources: string[] } {
		const count = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
		const sources = this.db.prepare("SELECT DISTINCT source FROM chunks ORDER BY source").all() as Array<{
			source: string;
		}>;
		return {
			totalChunks: count.count,
			sources: sources.map((s) => s.source),
		};
	}

	close(): void {
		this.db.close();
	}
}
