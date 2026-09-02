/**
 * SOAK READER — reads back every generation a soak log has written, tolerating
 * the one kind of damage the writer's no-fsync append can leave behind.
 *
 * The reader is the offline half: a verdict tool, a test, or an operator runs
 * it, never the hot path. It therefore does the opposite of the writer on one
 * point — it REPORTS damage instead of swallowing it — but it still never
 * throws on damage, because refusing to read a week of evidence over one torn
 * line would be the same failure the retention floor exists to prevent.
 *
 * TORN TAIL. The writer does not fsync, so a hard power cut can leave the final
 * line of a file unterminated (or truncated mid-JSON). That specific case is
 * expected: the partial tail is dropped, the file is reported in `torn`, and the
 * bytes are handed back in `tornTails` so a caller that cares can look. This is
 * the same tolerance the install journal's reader implements.
 *
 * MALFORMED ELSEWHERE. A bad line anywhere but the end is NOT an expected torn
 * tail — it is genuine corruption or a foreign writer. It is collected in
 * `malformed` with its file and 1-based line number rather than thrown, so one
 * bad line costs one line.
 *
 * ORDERING. Records come back in file order: generations oldest-first by their
 * embedded generation stamp, then the active file. Within a file, byte order.
 * ACROSS files the wall clocks can overlap by design — a writer holding a
 * descriptor keeps appending to a generation after it was renamed — so sort by
 * `wall` if you need a global timeline.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listGenerationFiles, SOAK_STEM_SESSION, type SoakRecord } from "./soak-log.js";

/** A line that parsed as neither a torn tail nor a record. */
export interface SoakMalformedLine {
	file: string;
	/** 1-based line number within `file`. */
	line: number;
	raw: string;
	reason: string;
}

export interface SoakReadResult {
	records: SoakRecord[];
	/** Files read, in the order they were read. */
	files: string[];
	/** Files whose final line was an unterminated append. */
	torn: string[];
	/** The unterminated bytes, keyed by file name. */
	tornTails: Record<string, string>;
	/** Lines that were neither a record nor a torn tail. Expected to be empty. */
	malformed: SoakMalformedLine[];
}

export interface ReadSoakLogOptions {
	/** Soak directory to read. */
	dir: string;
	/** Which half to read: `session` (default) or `daemon`. */
	stem?: string;
	/** Keep only these events. */
	events?: readonly string[];
}

/** Every soak file for `stem`, in read order: generations oldest-first, then the active file. */
export function listSoakFiles(dir: string, stem: string = SOAK_STEM_SESSION): string[] {
	const paths = listGenerationFiles(dir, stem).map((generation) => generation.path);
	const active = join(dir, `${stem}.jsonl`);
	try {
		if (statSync(active).isFile()) paths.push(active);
	} catch {
		/* no active file yet */
	}
	return paths;
}

/** Reads every generation plus the active file. Never throws on damaged content. */
export function readSoakLog(options: ReadSoakLogOptions): SoakReadResult {
	const stem = options.stem ?? SOAK_STEM_SESSION;
	const wanted = options.events ? new Set(options.events) : undefined;
	const result: SoakReadResult = { records: [], files: [], torn: [], tornTails: {}, malformed: [] };

	for (const path of listSoakFiles(options.dir, stem)) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue; // pruned between listing and reading
		}
		result.files.push(path);
		if (raw.length === 0) continue;

		const lines = raw.split("\n");
		if (raw.endsWith("\n")) {
			lines.pop(); // the empty string split() leaves after the final newline
		} else {
			const tail = lines.pop() ?? "";
			result.torn.push(path);
			result.tornTails[path] = tail;
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") continue;
			const parsed = parseSoakLine(line);
			if (typeof parsed === "string") {
				result.malformed.push({ file: path, line: i + 1, raw: line, reason: parsed });
				continue;
			}
			if (wanted && !wanted.has(parsed.event)) continue;
			result.records.push(parsed);
		}
	}

	return result;
}

/** Returns the record, or a reason string when the line is not one. */
function parseSoakLine(line: string): SoakRecord | string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return "not a JSON object";
	}
	const candidate = parsed as Partial<SoakRecord>;
	if (typeof candidate.event !== "string") return "missing event";
	if (typeof candidate.wall !== "number") return "missing wall";
	if (typeof candidate.pid !== "number") return "missing pid";
	return candidate as SoakRecord;
}
