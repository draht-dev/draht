import { resolve } from "node:path";
import { previewPatch, readEditableFile } from "./patch.ts";
import type { ProposedBudgetFile } from "./workspace.ts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an edit object");
	return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`Missing ${name} in edit payload`);
	return value;
}

function replace(source: string, value: unknown): string {
	const edit = record(value);
	const before = text(edit.old_string ?? edit.oldText, "old_string");
	const after = text(edit.new_string ?? edit.newText, "new_string");
	if (!before || !source.includes(before)) throw new Error("Budget preview cannot locate the replacement text");
	if (edit.replace_all === true) return source.split(before).join(after);
	if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("Budget preview: ambiguous replacement");
	return source.replace(before, () => after);
}

export function previewTool(cwd: string, name: string, input: unknown): ProposedBudgetFile[] | undefined {
	const tool = name.split(/[.:]/).at(-1)?.toLowerCase();
	if (tool === "apply_patch") {
		const value = typeof input === "string" ? input : (record(input).patch ?? record(input).input);
		return previewPatch(cwd, text(value, "patch"));
	}
	if (tool !== "write" && tool !== "edit" && tool !== "multiedit") return undefined;
	const args = record(input);
	const path = resolve(cwd, text(args.file_path ?? args.path, "file_path"));
	if (tool === "write") return [{ path, content: text(args.content, "content") }];
	let content = readEditableFile(path);
	if (tool === "multiedit") {
		if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("Missing edits in MultiEdit");
		for (const edit of args.edits) content = replace(content, edit);
	} else content = replace(content, args);
	return [{ path, content }];
}
