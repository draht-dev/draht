import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_CENTRAL_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 16;

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name) {
	return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(name)
		&& !name.startsWith("/") && !name.includes("../") && !name.includes("\\") && !/^[A-Za-z]:/.test(name);
}

function locateEocd(zip) {
	const start = Math.max(0, zip.length - 65_557);
	for (let offset = zip.length - 22; offset >= start; offset--) {
		if (zip.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) return offset;
	}
	throw new Error("invalid ZIP: end-of-central-directory record not found within the bounded search window");
}

function inspectZip(zip, { binary, binaryBytes, maxUncompressedBytes, maxCompressedBytes }) {
	if (!Number.isSafeInteger(binaryBytes) || binaryBytes <= 0 || !Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0 || !Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
		throw new Error("invalid ZIP extraction byte limits");
	}
	const eocd = locateEocd(zip);
	const disk = zip.readUInt16LE(eocd + 4);
	const centralDisk = zip.readUInt16LE(eocd + 6);
	const diskEntries = zip.readUInt16LE(eocd + 8);
	const entryCount = zip.readUInt16LE(eocd + 10);
	const centralSize = zip.readUInt32LE(eocd + 12);
	const centralOffset = zip.readUInt32LE(eocd + 16);
	if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 || entryCount > MAX_ENTRIES || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("unsupported ZIP disk, ZIP64, or entry count");
	if (centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize !== eocd || centralOffset + centralSize > zip.length) throw new Error("ZIP central directory exceeds its bounded parsing limit");
	const entries = [];
	const names = new Set();
	let offset = centralOffset;
	let totalCompressed = 0;
	let totalUncompressed = 0;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > eocd || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("invalid ZIP central directory entry");
		const madeBy = zip.readUInt16LE(offset + 4) >>> 8;
		const flags = zip.readUInt16LE(offset + 8);
		const method = zip.readUInt16LE(offset + 10);
		const crc = zip.readUInt32LE(offset + 16);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const uncompressedSize = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const external = zip.readUInt32LE(offset + 38);
		const localOffset = zip.readUInt32LE(offset + 42);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (end > eocd || nameLength === 0 || nameLength > 1024) throw new Error("invalid or oversized ZIP member name");
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (!safeName(name)) throw new Error(`unsafe ZIP member path: ${name}`);
		if (names.has(name)) throw new Error(`duplicate ZIP member: ${name}`);
		names.add(name);
		if (flags & 1) throw new Error(`encrypted ZIP member is not allowed: ${name}`);
		if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method for ${name}`);
		const unixMode = madeBy === 3 ? (external >>> 16) & 0xffff : 0;
		const unixType = unixMode & 0xf000;
		const directory = name.endsWith("/");
		if (unixType && unixType !== (directory ? 0x4000 : 0x8000)) throw new Error(`unsafe ZIP link, device, or special member type: ${name}`);
		if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) throw new Error(`invalid ZIP directory member size: ${name}`);
		totalCompressed += compressedSize;
		totalUncompressed += uncompressedSize;
		if (!Number.isSafeInteger(totalCompressed) || totalCompressed > maxCompressedBytes) throw new Error("ZIP aggregate compressed size exceeds byte limit");
		if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > maxUncompressedBytes) throw new Error("ZIP aggregate uncompressed size exceeds byte limit");
		entries.push({ name, directory, flags, method, crc, compressedSize, uncompressedSize, localOffset });
		offset = end;
	}
	if (offset !== eocd) throw new Error("ZIP central directory has trailing or missing records");
	const expected = new Set(["draht-graph/", `draht-graph/${binary}`, "draht-graph/README.md", "draht-graph/LICENSE"]);
	for (const name of names) if (!expected.has(name)) throw new Error(`unexpected ZIP member: ${name}`);
	for (const name of expected) if (!names.has(name)) throw new Error(`missing ZIP member required by exact payload: ${name}`);
	const binaryEntry = entries.find((entry) => entry.name === `draht-graph/${binary}`);
	if (binaryEntry.uncompressedSize !== binaryBytes) throw new Error("ZIP expected binary size does not match manifest");
	return entries;
}

export function extractGraphZip(archivePath, destDir, options) {
	const zip = fs.readFileSync(archivePath);
	const entries = inspectZip(zip, options);
	fs.mkdirSync(destDir, { recursive: true });
	for (const entry of entries) {
		const outPath = path.join(destDir, ...entry.name.split("/"));
		if (entry.directory) {
			fs.mkdirSync(outPath, { recursive: true });
			continue;
		}
		if (entry.localOffset + 30 > zip.length || zip.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new Error(`invalid ZIP local header for ${entry.name}`);
		const localFlags = zip.readUInt16LE(entry.localOffset + 6);
		const localMethod = zip.readUInt16LE(entry.localOffset + 8);
		const nameLength = zip.readUInt16LE(entry.localOffset + 26);
		const extraLength = zip.readUInt16LE(entry.localOffset + 28);
		const dataStart = entry.localOffset + 30 + nameLength + extraLength;
		const dataEnd = dataStart + entry.compressedSize;
		if ((localFlags & 1) || localMethod !== entry.method || dataEnd > zip.length) throw new Error(`invalid ZIP local member metadata for ${entry.name}`);
		const localName = zip.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength).toString("utf8");
		if (localName !== entry.name) throw new Error(`ZIP local/central member name mismatch for ${entry.name}`);
		const compressed = zip.subarray(dataStart, dataEnd);
		let bytes;
		try {
			bytes = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: Math.min(options.maxUncompressedBytes, entry.uncompressedSize + 1) });
		} catch (error) {
			throw new Error(`ZIP member expanded beyond its declared uncompressed size: ${entry.name}`, { cause: error });
		}
		if (bytes.length !== entry.uncompressedSize) throw new Error(`ZIP member uncompressed size mismatch: ${entry.name}`);
		if (crc32(bytes) !== entry.crc) throw new Error(`ZIP member CRC mismatch: ${entry.name}`);
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, bytes, { flag: "wx" });
	}
}
