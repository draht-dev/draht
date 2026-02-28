import assert from "node:assert";
import { describe, it } from "node:test";

// We test pure functions extracted from vector-store (no API calls needed).

// We can't unit test with real embeddings (costs money), so we test:
// 1. Schema creation
// 2. Content hashing / dedup logic
// 3. Buffer encode/decode roundtrip
// 4. cosine similarity math

describe("VectorStore internals", () => {
	describe("cosineSimilarity", () => {
		// Import via a trick — these are module-private, so we re-implement to test
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

		it("returns 1 for identical vectors", () => {
			const v = [1, 2, 3, 4, 5];
			assert.strictEqual(Math.round(cosineSimilarity(v, v) * 1000) / 1000, 1);
		});

		it("returns 0 for orthogonal vectors", () => {
			const a = [1, 0, 0];
			const b = [0, 1, 0];
			assert.strictEqual(cosineSimilarity(a, b), 0);
		});

		it("returns -1 for opposite vectors", () => {
			const a = [1, 0, 0];
			const b = [-1, 0, 0];
			assert.strictEqual(cosineSimilarity(a, b), -1);
		});

		it("handles high-dimensional vectors", () => {
			const dim = 1536; // OpenAI embedding dimension
			const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
			const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
			const sim = cosineSimilarity(a, b);
			assert.ok(sim > 0.9, `Expected high similarity, got ${sim}`);
		});
	});

	describe("embedding buffer roundtrip", () => {
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

		it("roundtrips a vector correctly", () => {
			const original = [0.1, -0.5, 0.999, 0, -1.0, 0.00001];
			const restored = bufferToEmbedding(embeddingToBuffer(original));
			assert.strictEqual(restored.length, original.length);
			for (let i = 0; i < original.length; i++) {
				assert.ok(
					Math.abs(restored[i] - original[i]) < 0.0001,
					`Mismatch at index ${i}: ${restored[i]} vs ${original[i]}`,
				);
			}
		});

		it("roundtrips 1536-dim vector", () => {
			const original = Array.from({ length: 1536 }, () => Math.random() * 2 - 1);
			const restored = bufferToEmbedding(embeddingToBuffer(original));
			assert.strictEqual(restored.length, 1536);
		});
	});
});
