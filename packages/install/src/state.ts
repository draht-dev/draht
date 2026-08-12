import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.ts";
import { type InstallState, InstallStateSchema } from "./types.ts";

/** Thrown by `loadState` when `state.json` exists but cannot be parsed or fails schema validation. */
export class StateCorruptError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "StateCorruptError";
	}
}

/** A fresh install root's starting state: schema v1, `latest` channel, default profile, no components. */
export function createDefaultState(): InstallState {
	return {
		schemaVersion: 1,
		channel: "latest",
		profile: { mode: "default", selectors: [] },
		components: {},
	};
}

/**
 * Loads `state.json` from `root`. A missing file is a fresh install root,
 * not an error — returns `createDefaultState()`. An existing file that isn't
 * valid JSON or doesn't match `InstallStateSchema` throws `StateCorruptError`
 * rather than silently discarding whatever the engine last knew.
 */
export function loadState(root: string): InstallState {
	const path = statePath(root);
	if (!existsSync(path)) {
		return createDefaultState();
	}

	const raw = readFileSync(path, "utf8");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new StateCorruptError(`state file at ${path} is not valid JSON`, error);
	}

	const result = InstallStateSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
		throw new StateCorruptError(`state file at ${path} does not match the expected schema: ${issues.join("; ")}`);
	}
	return result.data;
}

/**
 * Writes `state.json` crash-atomically: serialize, write to a temp file in
 * the same directory, fsync the file, `renameSync` over the real path (a
 * same-filesystem rename is atomic — readers only ever see the old or the
 * new document, never a torn write), then best-effort fsync the directory so
 * the rename itself is durable across a crash.
 */
export function saveState(root: string, state: InstallState): void {
	mkdirSync(root, { recursive: true });
	const path = statePath(root);
	const serialized = `${JSON.stringify(state, null, 2)}\n`;
	const tmpPath = join(root, `.state.json.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);

	const fd = openSync(tmpPath, "w");
	try {
		writeSync(fd, serialized);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}

	renameSync(tmpPath, path);

	try {
		const dirFd = openSync(root, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// Directory fsync is best-effort: not every platform allows opening a
		// directory for reading (e.g. Windows), and the rename above is already
		// durable on the filesystems this engine targets.
	}
}
