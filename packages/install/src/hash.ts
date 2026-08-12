import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Hex-encoded sha256 digest of a UTF-8 string. */
export function sha256String(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hex-encoded sha256 digest of a file's contents. */
export async function sha256File(path: string): Promise<string> {
	const buffer = await readFile(path);
	return createHash("sha256").update(buffer).digest("hex");
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function collectFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(fullPath));
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}
	return results;
}

/**
 * Recursively hashes every regular file under `dir`, returning `{ path, sha256 }`
 * pairs sorted by `path` (POSIX-separated, relative to `dir`) for deterministic
 * output regardless of directory-read order. A missing `dir` yields `[]`.
 */
export async function hashTree(dir: string): Promise<Array<{ path: string; sha256: string }>> {
	if (!existsSync(dir)) return [];
	const files = collectFiles(dir);
	const hashed = await Promise.all(
		files.map(async (absolutePath) => ({
			path: toPosixPath(relative(dir, absolutePath)),
			sha256: await sha256File(absolutePath),
		})),
	);
	return hashed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const INTEGRITY_PATTERN = /^(sha256|sha512)-(.+)$/;

/**
 * Verifies an ssri-style integrity string (`sha256-<base64>` / `sha512-<base64>`,
 * the format npm registry `dist.integrity` uses — typically sha512) against a
 * buffer. Unknown algorithms and mismatched digests both return `false`.
 */
export function verifyIntegrity(buffer: Buffer, integrity: string): boolean {
	const match = INTEGRITY_PATTERN.exec(integrity.trim());
	if (!match) return false;
	const [, algorithm, expectedBase64] = match;
	const actualBase64 = createHash(algorithm).update(buffer).digest("base64");
	return actualBase64 === expectedBase64;
}
