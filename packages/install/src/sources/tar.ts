import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { assertSafeRelativePath, SafetyError } from "../safety.ts";
import { SourceError } from "./types.ts";

export interface TarLimits {
	/** Maximum number of archive members. */
	maxEntries: number;
	/** Maximum total expanded bytes. Also caps gunzip output, so a bomb never fully decompresses. */
	maxTotalBytes: number;
	/** Maximum bytes in a single member. */
	maxEntryBytes: number;
}

/**
 * Bounds sized for the payloads this engine actually installs (plugin trees of
 * a few hundred small files). They are limits, not predictions: an archive
 * that exceeds them is refused rather than trusted.
 */
export const DEFAULT_TAR_LIMITS: TarLimits = {
	maxEntries: 20_000,
	maxTotalBytes: 128 * 1024 * 1024,
	maxEntryBytes: 64 * 1024 * 1024,
};

const BLOCK = 512;

/** ustar typeflags this extractor will write. Everything else — links, devices, fifos, GNU/pax extensions — is refused. */
const REGULAR_FILE_FLAGS = new Set(["0", "\0", "", "7"]);
const DIRECTORY_FLAG = "5";
const PAX_NEXT_FLAG = "x";
const PAX_GLOBAL_FLAG = "g";

const REJECTED_FLAG_LABELS: Record<string, string> = {
	"1": "hard link",
	"2": "symbolic link",
	"3": "character device",
	"4": "block device",
	"6": "FIFO",
	L: "GNU long-name extension",
	K: "GNU long-link extension",
};

export interface ExtractResult {
	/** Extracted file paths relative to `destDir`, POSIX-separated and sorted. */
	files: string[];
	totalBytes: number;
}

function readString(buffer: Buffer, start: number, length: number): string {
	const slice = buffer.subarray(start, start + length);
	const nul = slice.indexOf(0);
	return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function readOctal(buffer: Buffer, start: number, length: number): number {
	const raw = readString(buffer, start, length).trim();
	if (raw === "") return 0;
	const parsed = Number.parseInt(raw, 8);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new SourceError("tar-malformed", `archive header has an invalid numeric field ${JSON.stringify(raw)}`);
	}
	return parsed;
}

/** POSIX tar checksum: the checksum field itself is treated as eight spaces. */
function assertHeaderChecksum(header: Buffer): void {
	const recorded = readOctal(header, 148, 8);
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (recorded !== actual) {
		throw new SourceError(
			"tar-malformed",
			`archive header checksum mismatch: expected ${recorded}, calculated ${actual}`,
		);
	}
}

/** Parses the `key=value` records of a pax extended header, returning only the keys this reader honors. */
function parsePaxRecords(data: Buffer): { path?: string } {
	const result: { path?: string } = {};
	let offset = 0;
	const text = data.toString("utf8");
	while (offset < text.length) {
		const space = text.indexOf(" ", offset);
		if (space === -1) break;
		const length = Number.parseInt(text.slice(offset, space), 10);
		if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) {
			throw new SourceError("tar-malformed", "archive has a malformed pax extended header record");
		}
		const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
		const eq = record.indexOf("=");
		if (eq !== -1) {
			const key = record.slice(0, eq);
			if (key === "path") result.path = record.slice(eq + 1);
		}
		offset += length;
	}
	return result;
}

/**
 * Extracts a gzipped npm tarball into `destDir`, applying every structural
 * check before a single byte is written.
 *
 * npm archives place all content under a single `package/` directory; that
 * prefix is stripped, and an entry outside it is refused rather than written
 * somewhere surprising. Path safety is delegated to `assertSafeRelativePath`
 * so archive entries and recorded state paths obey exactly the same grammar.
 *
 * Rejections (all fail before any write): non-gzip data, decompressed size
 * over the bound, member count over the bound, per-member size over the bound,
 * any non-regular/non-directory member, GNU long-name extensions, traversal or
 * absolute paths, entries outside `package/`, and two members resolving to the
 * same path.
 */
export function extractTarGz(archive: Buffer, destDir: string, limits: TarLimits = DEFAULT_TAR_LIMITS): ExtractResult {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: limits.maxTotalBytes });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ERR_BUFFER_TOO_LARGE") {
			throw new SourceError(
				"tar-too-large",
				`archive expands beyond the ${limits.maxTotalBytes} byte limit and was refused before extraction`,
				error,
			);
		}
		throw new SourceError("tar-malformed", `archive is not valid gzip data: ${(error as Error).message}`, error);
	}

	// Two passes: parse and validate the whole archive into memory-described
	// entries first, write only once everything has passed. A rejected archive
	// therefore never leaves a partial tree behind.
	interface PendingEntry {
		path: string;
		content: Buffer;
		isDirectory: boolean;
	}
	const pending: PendingEntry[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;
	let entryCount = 0;
	let offset = 0;
	let paxPathOverride: string | undefined;

	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break; // end-of-archive marker
		assertHeaderChecksum(header);

		const rawName = readString(header, 0, 100);
		const prefix = readString(header, 345, 155);
		const size = readOctal(header, 124, 12);
		const typeflag = String.fromCharCode(header[156] ?? 0);
		offset += BLOCK;
		const dataStart = offset;
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		if (dataStart + size > tar.length || offset > tar.length) {
			throw new SourceError("tar-malformed", `archive member ${JSON.stringify(rawName)} is truncated`);
		}

		if (typeflag === PAX_GLOBAL_FLAG) {
			// Global pax headers carry defaults this reader honors none of.
			continue;
		}
		if (typeflag === PAX_NEXT_FLAG) {
			paxPathOverride = parsePaxRecords(tar.subarray(dataStart, dataStart + size)).path;
			continue;
		}
		if (REJECTED_FLAG_LABELS[typeflag]) {
			throw new SourceError(
				"tar-unsafe-entry",
				`archive contains a ${REJECTED_FLAG_LABELS[typeflag]} entry (${JSON.stringify(rawName)}); only regular files and directories are accepted`,
			);
		}
		const isDirectory = typeflag === DIRECTORY_FLAG;
		if (!isDirectory && !REGULAR_FILE_FLAGS.has(typeflag)) {
			throw new SourceError(
				"tar-unsafe-entry",
				`archive contains an entry of unsupported type ${JSON.stringify(typeflag)} (${JSON.stringify(rawName)})`,
			);
		}

		const fullName = paxPathOverride ?? (prefix === "" ? rawName : `${prefix}/${rawName}`);
		paxPathOverride = undefined;

		entryCount += 1;
		if (entryCount > limits.maxEntries) {
			throw new SourceError("tar-too-many-entries", `archive has more than ${limits.maxEntries} members`);
		}
		if (size > limits.maxEntryBytes) {
			throw new SourceError(
				"tar-too-large",
				`archive member ${JSON.stringify(fullName)} is ${size} bytes, over the ${limits.maxEntryBytes} byte per-member limit`,
			);
		}

		const relative = stripPackagePrefix(fullName);
		if (relative === null) {
			// The bare `package/` directory entry itself carries no content.
			continue;
		}

		if (isDirectory) continue; // directories are implied by their files

		try {
			assertSafeRelativePath(relative);
		} catch (error) {
			if (error instanceof SafetyError) {
				throw new SourceError("tar-unsafe-entry", error.message, error);
			}
			throw error;
		}

		if (seen.has(relative)) {
			throw new SourceError(
				"tar-duplicate-entry",
				`archive contains duplicate entries for ${JSON.stringify(relative)}`,
			);
		}
		seen.add(relative);

		totalBytes += size;
		if (totalBytes > limits.maxTotalBytes) {
			throw new SourceError(
				"tar-too-large",
				`archive expands to more than the ${limits.maxTotalBytes} byte total size limit`,
			);
		}

		pending.push({ path: relative, content: tar.subarray(dataStart, dataStart + size), isDirectory: false });
	}

	if (pending.length === 0) {
		throw new SourceError("tar-empty", "archive contains no files under package/");
	}

	mkdirSync(destDir, { recursive: true, mode: 0o700 });
	try {
		for (const entry of pending) {
			const outPath = join(destDir, entry.path);
			mkdirSync(dirname(outPath), { recursive: true });
			writeFileSync(outPath, entry.content, { mode: 0o600 });
		}
	} catch (error) {
		rmSync(destDir, { recursive: true, force: true });
		throw new SourceError(
			"tar-write-failed",
			`could not write extracted archive: ${(error as Error).message}`,
			error,
		);
	}

	return { files: pending.map((entry) => entry.path).sort(), totalBytes };
}

/**
 * Removes the single leading `package/` component npm archives use. Returns
 * `null` for the bare `package` entry itself, and throws for anything that
 * lives outside it — an archive that ships files beside `package/` is not
 * something this engine knows how to install.
 */
function stripPackagePrefix(name: string): string | null {
	const normalized = name.replace(/^\.\//, "");
	if (normalized === "package" || normalized === "package/") return null;
	if (!normalized.startsWith("package/")) {
		throw new SourceError(
			"tar-unsafe-entry",
			`archive entry ${JSON.stringify(name)} is outside the expected package/ root`,
		);
	}
	return normalized.slice("package/".length);
}
