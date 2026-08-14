/**
 * CheckpointManager — working-tree snapshot capture and durable storage (Phase 41).
 *
 * Captures git snapshots of the working tree via a temporary index
 * (`GIT_INDEX_FILE` + `add -A` + `write-tree` + `commit-tree`) and anchors
 * them at `refs/draht/checkpoints/<session-id>/<entry-id>` so they are
 * GC-proof and invisible to the user's git workflow: the user's index,
 * `HEAD`, stash, and reflog are never touched, and `git stash` is never used.
 *
 * Metadata lives in a sidecar JSONL next to the session file
 * (`<session-file>.checkpoints.jsonl`).
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Ref namespace for checkpoint snapshots: `refs/draht/checkpoints/<session-id>/<entry-id>`. */
export const CHECKPOINT_REF_PREFIX = "refs/draht/checkpoints";

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Identity for snapshot commits. Passed explicitly so capture works in
 * repositories (and environments) with no configured git identity — the user's
 * own config is never read for this and never written.
 */
const CHECKPOINT_IDENTITY = {
	GIT_AUTHOR_NAME: "draht",
	GIT_AUTHOR_EMAIL: "checkpoints@draht.local",
	GIT_COMMITTER_NAME: "draht",
	GIT_COMMITTER_EMAIL: "checkpoints@draht.local",
} as const;

/** One sidecar line: metadata for a single captured checkpoint. */
export interface CheckpointRecord {
	/** Session entry id the snapshot is keyed to. */
	entryId: string;
	/** Fully-qualified git ref anchoring the snapshot commit. */
	ref: string;
	/** Tree hash of the snapshot commit (dedup anchor). */
	treeHash: string;
	/** ISO-8601 capture time. */
	timestamp: string;
	/** Number of files differing from HEAD at capture time. */
	dirtyFileCount: number;
}

export type CheckpointCaptureStatus = "created" | "deduplicated" | "disabled" | "failed";

export interface CheckpointCaptureResult {
	status: CheckpointCaptureStatus;
	/** Set when status is "created". */
	record?: CheckpointRecord;
	/** Set when status is "disabled" or "failed". */
	reason?: string;
}

export interface CheckpointManagerOptions {
	/** Directory whose containing git repository is snapshotted. */
	cwd: string;
	/** Session id used to namespace refs. */
	sessionId: string;
	/** Session file path; the sidecar lives next to it. */
	sessionFile: string;
}

export interface CheckpointPruneOptions {
	/** Delete refs whose snapshot commit is older than this. Default: 30. */
	retentionDays?: number;
	/** Keep at most this many newest refs per session namespace. Default: unlimited. */
	maxPerSession?: number;
	/** Report what would be deleted without deleting. */
	dryRun?: boolean;
	/** Clock override for tests. */
	now?: Date;
}

export interface CheckpointPruneResult {
	/** Total checkpoint refs found in the repository. */
	examined: number;
	/** Refs deleted (or, with dryRun, refs that would be deleted). */
	deleted: string[];
}

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
}

async function isGitRepository(cwd: string): Promise<boolean> {
	try {
		return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
	} catch {
		return false;
	}
}

/**
 * Make one path component safe to use inside a git ref name. Session ids and
 * entry ids are opaque to us, so anything `git check-ref-format` would reject
 * (`..`, control/special characters, leading or trailing punctuation, a
 * `.lock` suffix) is folded to `-`.
 */
function sanitizeRefComponent(value: string): string {
	let out = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
	out = out.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
	if (out.endsWith(".lock")) out = `${out.slice(0, -".lock".length)}-lock`;
	return out.length > 0 ? out : "checkpoint";
}

/** Path of the checkpoint metadata sidecar for a session file. */
export function checkpointSidecarPath(sessionFile: string): string {
	return `${sessionFile}.checkpoints.jsonl`;
}

function toCheckpointRecord(value: unknown): CheckpointRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.entryId !== "string" ||
		typeof candidate.ref !== "string" ||
		typeof candidate.treeHash !== "string" ||
		typeof candidate.timestamp !== "string" ||
		typeof candidate.dirtyFileCount !== "number"
	) {
		return undefined;
	}
	return {
		entryId: candidate.entryId,
		ref: candidate.ref,
		treeHash: candidate.treeHash,
		timestamp: candidate.timestamp,
		dirtyFileCount: candidate.dirtyFileCount,
	};
}

/** Read all valid records from a sidecar file. Malformed lines are skipped. */
export function readCheckpointSidecar(sidecarPath: string): CheckpointRecord[] {
	if (!existsSync(sidecarPath)) return [];
	let content: string;
	try {
		content = readFileSync(sidecarPath, "utf8");
	} catch {
		return [];
	}

	const records: CheckpointRecord[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const record = toCheckpointRecord(parsed);
		if (record) records.push(record);
	}
	return records;
}

function appendCheckpointRecord(sidecarPath: string, record: CheckpointRecord): void {
	mkdirSync(dirname(sidecarPath), { recursive: true });
	appendFileSync(sidecarPath, `${JSON.stringify(record)}\n`);
}

/**
 * Copy sidecar records for preserved entry ids from one session file's
 * sidecar to another's (used by /fork and /clone). Returns the number of
 * records copied. Refs are copied verbatim — they keep pointing at the
 * source session's namespace, which stays anchored in the repository.
 */
export function propagateCheckpointSidecar(
	sourceSessionFile: string,
	targetSessionFile: string,
	preservedEntryIds: ReadonlySet<string>,
): number {
	const source = readCheckpointSidecar(checkpointSidecarPath(sourceSessionFile));
	const kept = source.filter((record) => preservedEntryIds.has(record.entryId));
	if (kept.length === 0) return 0;

	const target = checkpointSidecarPath(targetSessionFile);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${kept.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return kept.length;
}

export class CheckpointManager {
	private readonly cwd: string;
	private readonly sessionId: string;
	private readonly sidecarPath: string;

	constructor(options: CheckpointManagerOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.sidecarPath = checkpointSidecarPath(options.sessionFile);
	}

	/**
	 * Capture a snapshot of the working tree keyed to the given session entry
	 * id, unless the tree hash equals the previous checkpoint's (dedup).
	 * Never throws for expected conditions: non-git cwds report "disabled",
	 * git failures report "failed".
	 */
	async captureIfChanged(entryId: string): Promise<CheckpointCaptureResult> {
		if (!(await isGitRepository(this.cwd))) {
			return { status: "disabled", reason: `${this.cwd} is not inside a git repository` };
		}

		let indexDir: string | undefined;
		try {
			indexDir = mkdtempSync(join(tmpdir(), "draht-checkpoint-index-"));
			// A private index keeps `add -A` off the user's real index entirely.
			const indexEnv = { ...CHECKPOINT_IDENTITY, GIT_INDEX_FILE: join(indexDir, "index") };
			await git(this.cwd, ["add", "-A"], indexEnv);
			const treeHash = await git(this.cwd, ["write-tree"], indexEnv);

			const previous = this.list().at(-1);
			if (previous?.treeHash === treeHash) return { status: "deduplicated" };

			const commit = await git(
				this.cwd,
				["commit-tree", treeHash, "-m", `draht checkpoint ${entryId}`],
				CHECKPOINT_IDENTITY,
			);
			const ref = `${CHECKPOINT_REF_PREFIX}/${sanitizeRefComponent(this.sessionId)}/${sanitizeRefComponent(entryId)}`;
			await git(this.cwd, ["update-ref", ref, commit], CHECKPOINT_IDENTITY);

			const record: CheckpointRecord = {
				entryId,
				ref,
				treeHash,
				timestamp: new Date().toISOString(),
				dirtyFileCount: await this.countDirtyFiles(treeHash),
			};
			appendCheckpointRecord(this.sidecarPath, record);
			return { status: "created", record };
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			if (indexDir) rmSync(indexDir, { recursive: true, force: true });
		}
	}

	/** Files in the snapshot that differ from HEAD; the whole tree when HEAD is unborn. */
	private async countDirtyFiles(treeHash: string): Promise<number> {
		try {
			const headTree = await git(this.cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
			const diff = await git(this.cwd, ["diff", "--name-only", headTree, treeHash]);
			return diff.length === 0 ? 0 : diff.split("\n").length;
		} catch {
			const files = await git(this.cwd, ["ls-tree", "-r", "--name-only", treeHash]);
			return files.length === 0 ? 0 : files.split("\n").length;
		}
	}

	/** All sidecar records for this session, in capture order. */
	list(): CheckpointRecord[] {
		return readCheckpointSidecar(this.sidecarPath);
	}

	/** Latest record for an entry id, if any. */
	get(entryId: string): CheckpointRecord | undefined {
		const records = this.list();
		for (let i = records.length - 1; i >= 0; i--) {
			if (records[i].entryId === entryId) return records[i];
		}
		return undefined;
	}

	/** Delete checkpoint refs per the retention policy. Repo-wide, all sessions. */
	static async pruneRepository(cwd: string, options: CheckpointPruneOptions = {}): Promise<CheckpointPruneResult> {
		if (!(await isGitRepository(cwd))) return { examined: 0, deleted: [] };

		const listing = await git(cwd, [
			"for-each-ref",
			"--format=%(refname)%09%(committerdate:iso-strict)",
			CHECKPOINT_REF_PREFIX,
		]);
		const refs = (listing.length === 0 ? [] : listing.split("\n")).flatMap((line) => {
			const [refname, committedAt] = line.split("\t");
			if (!refname || !committedAt) return [];
			const at = new Date(committedAt).getTime();
			return Number.isNaN(at) ? [] : [{ refname, at }];
		});

		const doomed = new Set<string>();
		const cutoff = (options.now ?? new Date()).getTime() - (options.retentionDays ?? 30) * MILLISECONDS_PER_DAY;
		for (const ref of refs) {
			if (ref.at < cutoff) doomed.add(ref.refname);
		}

		if (options.maxPerSession !== undefined) {
			const bySession = new Map<string, typeof refs>();
			for (const ref of refs) {
				const session = ref.refname.slice(CHECKPOINT_REF_PREFIX.length + 1).split("/")[0] ?? "";
				const group = bySession.get(session) ?? [];
				group.push(ref);
				bySession.set(session, group);
			}
			for (const group of bySession.values()) {
				const newestFirst = [...group].sort((a, b) => b.at - a.at);
				for (const surplus of newestFirst.slice(options.maxPerSession)) doomed.add(surplus.refname);
			}
		}

		const deleted = [...doomed].sort();
		if (!options.dryRun) {
			for (const ref of deleted) await git(cwd, ["update-ref", "-d", ref]);
		}
		return { examined: refs.length, deleted };
	}
}
