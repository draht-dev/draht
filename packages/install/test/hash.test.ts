import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashTree, sha256File, sha256String, verifyIntegrity } from "../src/hash.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "draht-install-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("sha256String", () => {
	it("matches the known SHA-256 vector for the empty string", () => {
		expect(sha256String("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it('matches the known SHA-256 vector for "abc"', () => {
		expect(sha256String("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("sha256File", () => {
	it("hashes a file's contents to the same known vector", async () => {
		const filePath = join(root, "file.txt");
		writeFileSync(filePath, "abc");
		await expect(sha256File(filePath)).resolves.toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("hashTree", () => {
	it("is deterministic and returns POSIX-relative sorted paths regardless of directory-read order", async () => {
		mkdirSync(join(root, "b-dir"), { recursive: true });
		mkdirSync(join(root, "a-dir"), { recursive: true });
		writeFileSync(join(root, "b-dir", "file.txt"), "hello");
		writeFileSync(join(root, "a-dir", "file.txt"), "world");
		writeFileSync(join(root, "top.txt"), "top");

		const result = await hashTree(root);

		expect(result).toEqual([
			{ path: "a-dir/file.txt", sha256: sha256String("world") },
			{ path: "b-dir/file.txt", sha256: sha256String("hello") },
			{ path: "top.txt", sha256: sha256String("top") },
		]);

		// Re-running against the same, untouched tree produces the exact same array (determinism).
		expect(await hashTree(root)).toEqual(result);
	});

	it("returns an empty array for a missing directory", async () => {
		const missing = join(root, "does-not-exist");
		await expect(hashTree(missing)).resolves.toEqual([]);
	});
});

describe("verifyIntegrity", () => {
	it("accepts a correct sha512 ssri string", () => {
		const buffer = Buffer.from("abc");
		const digest = createHash("sha512").update(buffer).digest("base64");
		expect(verifyIntegrity(buffer, `sha512-${digest}`)).toBe(true);
	});

	it("rejects a wrong hash", () => {
		const buffer = Buffer.from("abc");
		const wrongDigest = createHash("sha512").update("not-abc").digest("base64");
		expect(verifyIntegrity(buffer, `sha512-${wrongDigest}`)).toBe(false);
	});

	it("rejects an unknown algorithm", () => {
		const buffer = Buffer.from("abc");
		const digest = createHash("sha256").update(buffer).digest("base64");
		expect(verifyIntegrity(buffer, `md5-${digest}`)).toBe(false);
	});
});
