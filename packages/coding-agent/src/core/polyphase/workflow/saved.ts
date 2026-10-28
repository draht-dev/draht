/**
 * Discovery of saved workflow scripts: `<agentDir>/workflows/*.js` (user) and the nearest
 * trusted `.draht/workflows/*.js` (project), mirroring `findProjectAgentsDir` in
 * `builtins/subagent.ts`. See DESIGN.md §16.1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { realPathStrict } from "../../../utils/canonical-path.ts";
import { extractWorkflowMeta, type MetaExtraction, WORKFLOW_NAME_PATTERN, type WorkflowPhaseMeta } from "./meta.ts";

export const SAVED_WORKFLOW_MAX_BYTES = 262_144;

export interface SavedWorkflow {
	name: string;
	description: string;
	whenToUse?: string;
	phases: WorkflowPhaseMeta[];
	path: string;
	source: "project" | "user";
	valid: boolean;
	error?: string;
}

export interface SavedWorkflowDiagnostic {
	path: string;
	level: "warning" | "info";
	message: string;
}

export interface SavedWorkflowSummary {
	name: string;
	description: string;
	source: "project" | "user";
	valid: boolean;
	command?: string;
}

export interface SavedDiscoveryOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

export interface DirDiscovery {
	workflows: SavedWorkflow[];
	diagnostics: SavedWorkflowDiagnostic[];
}

/**
 * `lstatSync` first, never `statSync` outright: a fifo, socket or device reports its real type
 * without being opened, so callers can refuse it before any `readSync` could block forever on it.
 * A symlink is followed once (saved workflows may be symlinked in), then the same check applies to
 * its target. Returns undefined for anything that isn't ultimately a regular file.
 */
function statRegularFile(filePath: string): fs.Stats | undefined {
	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(filePath);
	} catch {
		return undefined;
	}
	if (stats.isSymbolicLink()) {
		try {
			stats = fs.statSync(filePath);
		} catch {
			return undefined;
		}
	}
	return stats.isFile() ? stats : undefined;
}

type BoundedReadResult =
	| { kind: "ok"; content: string }
	/** The opened fd is not a regular file: a fifo, socket or device swapped in since the
	 * caller's own stat (TOCTOU). Caught here, on the fd itself, instead of only in a preceding
	 * `statRegularFile` call, which would still leave a race window before the open. */
	| { kind: "not-regular" }
	| { kind: "too-large" };

/** Reads up to `size` bytes from `fd`, stopping early at EOF. */
function readIntoBuffer(fd: number, size: number): { buffer: Buffer; bytesRead: number } {
	const buffer = Buffer.allocUnsafe(Math.max(0, size));
	let bytesRead = 0;
	while (bytesRead < buffer.length) {
		const chunk = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
		if (chunk === 0) break;
		bytesRead += chunk;
	}
	return { buffer, bytesRead };
}

/**
 * Opens with `O_NONBLOCK` (so a fifo with no writer returns immediately instead of blocking the
 * event loop) and rejects anything that isn't a regular file by `fstat`ing the opened descriptor,
 * which closes the TOCTOU window a separate `lstat`-then-`open` would leave between the two calls.
 *
 * `sizeHint` comes from a `statRegularFile` the caller already did, so the first read is sized for
 * the common case (a small script) instead of always zero-filling a 256 KiB buffer. If the file
 * grew past `sizeHint` since that stat, the first read fills exactly and a second read, sized to
 * the real remaining budget, decides whether the file is genuinely over `SAVED_WORKFLOW_MAX_BYTES`
 * or just grew by a few bytes — a `sizeHint`-sized probe alone would misreport the latter as too
 * large.
 */
function readBoundedUtf8(filePath: string, sizeHint: number): BoundedReadResult {
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		if (!fs.fstatSync(fd).isFile()) return { kind: "not-regular" };

		const hinted = Math.min(Math.max(sizeHint, 0), SAVED_WORKFLOW_MAX_BYTES);
		const first = readIntoBuffer(fd, hinted + 1);
		if (first.bytesRead <= hinted) {
			return { kind: "ok", content: first.buffer.toString("utf-8", 0, first.bytesRead) };
		}
		if (hinted >= SAVED_WORKFLOW_MAX_BYTES) return { kind: "too-large" };

		const rest = readIntoBuffer(fd, SAVED_WORKFLOW_MAX_BYTES - hinted);
		if (rest.bytesRead >= SAVED_WORKFLOW_MAX_BYTES - hinted) return { kind: "too-large" };

		const content = Buffer.concat([
			first.buffer.subarray(0, first.bytesRead),
			rest.buffer.subarray(0, rest.bytesRead),
		]).toString("utf-8");
		return { kind: "ok", content };
	} finally {
		fs.closeSync(fd);
	}
}

function metaToWorkflow(
	basename: string,
	filePath: string,
	source: "project" | "user",
	extraction: MetaExtraction,
): SavedWorkflow {
	if (!extraction.ok) {
		return {
			name: basename,
			description: "",
			phases: [],
			path: filePath,
			source,
			valid: false,
			error: `${extraction.error.message} (line ${extraction.error.line})`,
		};
	}
	const workflow: SavedWorkflow = {
		name: basename,
		description: extraction.meta.description,
		phases: extraction.meta.phases,
		path: filePath,
		source,
		valid: true,
	};
	if (extraction.meta.whenToUse !== undefined) workflow.whenToUse = extraction.meta.whenToUse;
	return workflow;
}

function loadWorkflowsFromDir(dir: string, source: "project" | "user"): DirDiscovery {
	const workflows: SavedWorkflow[] = [];
	const diagnostics: SavedWorkflowDiagnostic[] = [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { workflows, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".js")) continue;
		const filePath = path.join(dir, entry.name);

		const stat = statRegularFile(filePath);
		if (!stat) continue;
		if (stat.size > SAVED_WORKFLOW_MAX_BYTES) {
			diagnostics.push({
				path: filePath,
				level: "warning",
				message: `Saved workflow file "${entry.name}" was skipped: ${stat.size} bytes exceeds the ${SAVED_WORKFLOW_MAX_BYTES}-byte limit.`,
			});
			continue;
		}

		const basename = entry.name.slice(0, -3);
		if (!WORKFLOW_NAME_PATTERN.test(basename)) {
			diagnostics.push({
				path: filePath,
				level: "warning",
				message: `Saved workflow file "${entry.name}" was skipped: its name must match ${WORKFLOW_NAME_PATTERN} (lowercase letters, digits and hyphens, starting with a letter, at most 48 characters).`,
			});
			continue;
		}

		let content: string;
		try {
			const read = readBoundedUtf8(filePath, stat.size);
			if (read.kind === "not-regular") {
				diagnostics.push({
					path: filePath,
					level: "warning",
					message: `Saved workflow file "${entry.name}" was skipped: it is no longer a regular file.`,
				});
				continue;
			}
			if (read.kind === "too-large") {
				diagnostics.push({
					path: filePath,
					level: "warning",
					message: `Saved workflow file "${entry.name}" was skipped: it exceeds the ${SAVED_WORKFLOW_MAX_BYTES}-byte limit.`,
				});
				continue;
			}
			content = read.content;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				path: filePath,
				level: "warning",
				message: `Saved workflow "${basename}" could not be read: ${message}`,
			});
			continue;
		}

		const extraction = extractWorkflowMeta(content);
		if (!extraction.ok) {
			diagnostics.push({
				path: filePath,
				level: "warning",
				message: `Saved workflow "${basename}" has an invalid meta block: ${extraction.error.message} (line ${extraction.error.line}).`,
			});
			workflows.push(metaToWorkflow(basename, filePath, source, extraction));
			continue;
		}

		if (extraction.meta.name !== basename) {
			diagnostics.push({
				path: filePath,
				level: "info",
				message: `Saved workflow file "${entry.name}" declares meta.name "${extraction.meta.name}"; using the file name "${basename}" instead.`,
			});
		}

		workflows.push(metaToWorkflow(basename, filePath, source, extraction));
	}

	return { workflows, diagnostics };
}

/** Mirrors `findProjectAgentsDir` in `builtins/subagent.ts`: walk up from the real cwd for the nearest `.draht/workflows`. */
function findProjectWorkflowsDir(cwd: string): string | null {
	const realCwd = realPathStrict(cwd);
	if (realCwd === undefined) return null;
	let dir = realCwd;
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "workflows");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function discoverSavedWorkflows(options: SavedDiscoveryOptions): DirDiscovery {
	const userDir = path.join(options.agentDir, "workflows");
	const projectDir = options.projectTrusted ? findProjectWorkflowsDir(options.cwd) : null;

	const userResult = loadWorkflowsFromDir(userDir, "user");
	const projectResult = projectDir ? loadWorkflowsFromDir(projectDir, "project") : { workflows: [], diagnostics: [] };

	const diagnostics = [...userResult.diagnostics, ...projectResult.diagnostics];
	const byName = new Map<string, SavedWorkflow>();
	for (const workflow of userResult.workflows) byName.set(workflow.name, workflow);
	for (const workflow of projectResult.workflows) {
		const existing = byName.get(workflow.name);
		if (existing && existing.source === "user") {
			diagnostics.push({
				path: workflow.path,
				level: "info",
				message: `Project workflow "${workflow.name}" overrides the user workflow at ${existing.path}.`,
			});
		}
		byName.set(workflow.name, workflow);
	}

	const workflows = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
	return { workflows, diagnostics };
}

/**
 * Looks up a single name directly in the project then user workflow directories, instead of
 * discovering (opening, reading and meta-parsing) every file in both. Called on every workflow
 * approval and again on every saved-workflow execution, so a directory with many saved workflows
 * would otherwise redo that work twice per run.
 */
export function findSavedWorkflow(name: string, options: SavedDiscoveryOptions): SavedWorkflow | undefined {
	if (!WORKFLOW_NAME_PATTERN.test(name)) return undefined;

	if (options.projectTrusted) {
		const projectDir = findProjectWorkflowsDir(options.cwd);
		if (projectDir) {
			const found = loadSingleWorkflowFile(projectDir, name, "project");
			if (found) return found;
		}
	}
	return loadSingleWorkflowFile(path.join(options.agentDir, "workflows"), name, "user");
}

/**
 * Never throws: a read error (e.g. `EACCES`) or a file that is no longer a regular file or too
 * large is reported the same way discovery does, as "not found here", so `findSavedWorkflow`
 * falls back to the next source instead of raising an error from an unrelated code path.
 */
function loadSingleWorkflowFile(dir: string, name: string, source: "project" | "user"): SavedWorkflow | undefined {
	const filePath = path.join(dir, `${name}.js`);
	const stat = statRegularFile(filePath);
	if (!stat || stat.size > SAVED_WORKFLOW_MAX_BYTES) return undefined;
	try {
		const read = readBoundedUtf8(filePath, stat.size);
		if (read.kind !== "ok") return undefined;
		return metaToWorkflow(name, filePath, source, extractWorkflowMeta(read.content));
	} catch {
		return undefined;
	}
}

/**
 * Throws when the file is no longer a regular file (e.g. replaced by a fifo since discovery),
 * cannot be read, or has grown past {@link SAVED_WORKFLOW_MAX_BYTES} since discovery. The
 * `statRegularFile` call below is only an early refusal and a size hint for `readBoundedUtf8`;
 * the authoritative regular-file check happens on the opened fd inside `readBoundedUtf8` itself,
 * so a swap between this stat and that open (e.g. into a fifo) still can't hang the read.
 */
export function readSavedWorkflowSource(workflow: SavedWorkflow): string {
	const stat = statRegularFile(workflow.path);
	if (!stat) {
		throw new Error(`Saved workflow "${workflow.name}" is no longer a regular file.`);
	}
	if (stat.size > SAVED_WORKFLOW_MAX_BYTES) {
		throw new Error(
			`Saved workflow "${workflow.name}" is too large (${stat.size} bytes, max ${SAVED_WORKFLOW_MAX_BYTES}).`,
		);
	}
	const read = readBoundedUtf8(workflow.path, stat.size);
	if (read.kind === "not-regular") {
		throw new Error(`Saved workflow "${workflow.name}" is no longer a regular file.`);
	}
	if (read.kind === "too-large") {
		throw new Error(`Saved workflow "${workflow.name}" is too large (max ${SAVED_WORKFLOW_MAX_BYTES} bytes).`);
	}
	return read.content;
}
