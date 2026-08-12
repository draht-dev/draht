import { gzipSync } from "node:zlib";

export interface TarEntry {
	/** Full path as stored in the archive (npm tarballs prefix everything with `package/`). */
	path: string;
	content?: string | Buffer;
	/** ustar typeflag. "0" regular file, "5" directory, "2" symlink, "1" hardlink, "3"/"4"/"6" special. */
	typeflag?: string;
	/** Link target, for symlink/hardlink entries. */
	linkname?: string;
	mode?: number;
}

function octal(value: number, length: number): string {
	return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeString(header: Buffer, value: string, offset: number, length: number): void {
	header.write(value.slice(0, length - 1), offset, length - 1, "utf8");
}

/**
 * Builds a POSIX ustar header block. Deliberately hand-rolled so fixtures can
 * express archives a well-behaved packer would never produce — traversal
 * paths, symlinks, device nodes — which is exactly what the extractor's
 * rejection tests need.
 */
function buildHeader(entry: TarEntry, size: number): Buffer {
	const header = Buffer.alloc(512);
	writeString(header, entry.path, 0, 100);
	header.write(octal(entry.mode ?? 0o644, 8), 100, 8, "utf8");
	header.write(octal(0, 8), 108, 8, "utf8"); // uid
	header.write(octal(0, 8), 116, 8, "utf8"); // gid
	header.write(octal(size, 12), 124, 12, "utf8");
	header.write(octal(0, 12), 136, 12, "utf8"); // mtime
	header.write("        ", 148, 8, "utf8"); // checksum placeholder
	header.write(entry.typeflag ?? "0", 156, 1, "utf8");
	if (entry.linkname) writeString(header, entry.linkname, 157, 100);
	header.write("ustar\0", 257, 6, "utf8");
	header.write("00", 263, 2, "utf8");

	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
	return header;
}

/** Serializes entries into an uncompressed tar buffer. */
export function createTar(entries: TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const content = entry.content === undefined ? Buffer.alloc(0) : Buffer.from(entry.content);
		const size = entry.typeflag === "5" ? 0 : content.length;
		blocks.push(buildHeader(entry, size));
		if (size > 0) {
			blocks.push(content);
			const padding = (512 - (size % 512)) % 512;
			if (padding > 0) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(1024)); // end-of-archive
	return Buffer.concat(blocks);
}

/** Serializes entries into a gzipped tar buffer, the shape npm serves. */
export function createTarGz(entries: TarEntry[]): Buffer {
	return gzipSync(createTar(entries), { level: 9 });
}

/** Convenience: a minimal npm-shaped payload with a `package/` prefix and a manifest. */
export function createPackageTarGz(name: string, version: string, files: Record<string, string> = {}): Buffer {
	const entries: TarEntry[] = [
		{
			path: "package/package.json",
			content: `${JSON.stringify({ name, version }, null, 2)}\n`,
		},
	];
	for (const [path, content] of Object.entries(files)) {
		entries.push({ path: `package/${path}`, content });
	}
	return createTarGz(entries);
}
