import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ProposedBudgetFile } from "./workspace.ts";

/** Previews read only regular files: reading a pipe or device would block the hook. */
export function readEditableFile(path: string): string {
	if (!statSync(path).isFile()) throw new Error(`Budget preview reads only regular files: ${path}`);
	return readFileSync(path, "utf8");
}

function locate(lines: string[], match: string[], start: number, atEnd: boolean): number {
	const first = atEnd ? lines.length - match.length : start;
	const last = atEnd ? first : lines.length - match.length;
	for (const normalize of [(line: string) => line, (line: string) => line.trimEnd(), (line: string) => line.trim()]) {
		for (let index = Math.max(start, first); index <= last; index++) {
			if (match.every((line, offset) => normalize(lines[index + offset]) === normalize(line))) return index;
		}
	}
	throw new Error("Budget preview cannot locate a patch hunk; use an exact edit");
}

interface SourceLine {
	text: string;
	ending: string;
}

function update(content: string, patch: string[]): string {
	const source = Array.from(content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g))
		.filter((match) => match[0].length > 0)
		.map((match) => ({ text: match[1], ending: match[2] }));
	const lines = source.map((line) => line.text);
	const ending = source.find((line) => line.ending)?.ending ?? "\n";
	const replacements: Array<{ offset: number; length: number; lines: SourceLine[] }> = [];
	let cursor = 0;
	let index = 0;
	while (index < patch.length) {
		const header = patch[index++];
		if (header !== "@@" && !header.startsWith("@@ ")) throw new Error("Budget preview expected a patch hunk header");
		const anchor = header.slice(3);
		if (anchor) cursor = locate(lines, [anchor], cursor, false) + 1;
		const before: string[] = [];
		const operations: Array<{ kind: " " | "+" | "-"; text: string }> = [];
		let atEnd = false;
		while (index < patch.length && !patch[index].startsWith("@@")) {
			const line = patch[index++];
			if (line === "*** End of File") {
				atEnd = true;
				break;
			}
			const kind = line[0];
			if (kind !== " " && kind !== "+" && kind !== "-")
				throw new Error("Budget preview encountered an invalid patch line");
			const text = line.slice(1);
			if (kind !== "+") before.push(text);
			operations.push({ kind, text });
		}
		const offset = before.length ? locate(lines, before, cursor, atEnd) : lines.length;
		const replacement: SourceLine[] = [];
		let original = offset;
		for (const operation of operations) {
			if (operation.kind === "+") replacement.push({ text: operation.text, ending });
			else {
				if (operation.kind === " ") replacement.push(source[original]);
				original++;
			}
		}
		replacements.push({ offset, length: before.length, lines: replacement });
		if (before.length) cursor = offset + before.length;
	}
	const result: SourceLine[] = [];
	let consumed = 0;
	for (const replacement of replacements.sort((a, b) => a.offset - b.offset)) {
		if (replacement.offset < consumed) throw new Error("Budget preview encountered overlapping patch hunks");
		while (consumed < replacement.offset) result.push(source[consumed++]);
		for (const line of replacement.lines) result.push(line);
		consumed += replacement.length;
	}
	while (consumed < source.length) result.push(source[consumed++]);
	return result.map((line) => line.text + (line.ending || ending)).join("");
}

export function previewPatch(cwd: string, source: string): ProposedBudgetFile[] {
	const lines = source.trimEnd().split(/\r?\n/);
	if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
		throw new Error("Budget preview requires a complete apply_patch payload");
	}
	const changes = new Map<string, string | null>();
	let index = 0;
	while (index < lines.length) {
		const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index++]);
		if (!header) throw new Error("Budget preview encountered an unsupported patch operation");
		const [, operation, name] = header;
		const path = resolve(cwd, name);
		if (operation === "Delete") {
			changes.set(path, null);
			continue;
		}
		let destination = path;
		if (operation === "Update" && lines[index]?.startsWith("*** Move to: ")) {
			destination = resolve(cwd, lines[index++].slice("*** Move to: ".length));
		}
		const body: string[] = [];
		while (index < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[index])) {
			body.push(lines[index++]);
		}
		if (operation === "Add") {
			if (body.some((line) => !line.startsWith("+"))) throw new Error("Invalid added-file patch");
			changes.set(path, `${body.map((line) => line.slice(1)).join("\n")}\n`);
			continue;
		}
		const original = changes.has(path) ? changes.get(path) : readEditableFile(path);
		if (original === null || original === undefined) throw new Error("Cannot patch a deleted file");
		if (destination !== path) changes.set(path, null);
		changes.set(destination, update(original, body));
	}
	return [...changes].map(([path, content]) => ({ path, content }));
}
