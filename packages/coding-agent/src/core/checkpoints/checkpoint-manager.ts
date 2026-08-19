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
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Ref namespace for checkpoint snapshots: `refs/draht/checkpoints/<session-id>/<entry-id>`. */
export const CHECKPOINT_REF_PREFIX = "refs/draht/checkpoints";

/**
 * Ref-name segment marking a pre-rewind safety snapshot. Keeps safety refs out
 * of the plain `<session-id>/<entry-id>` name space so capturing one can never
 * overwrite the checkpoint already anchored for that entry.
 */
export const SAFETY_REF_SEGMENT = "pre-rewind";

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
	/**
	 * Unique id for this individual snapshot, stable for the life of the
	 * sidecar. `entryId` is *not* unique — a pre-rewind safety snapshot shares
	 * it with the checkpoint it is keyed to, and two rewinds from the same leaf
	 * produce two safety snapshots under the same `entryId` — so this is what
	 * makes every recovery point independently addressable (see
	 * `getRecoveryPoint`). Optional only for sidecars written before it existed.
	 */
	recoveryId?: string;
	/** `"safety"` for pre-rewind snapshots, `"checkpoint"` for turn captures. */
	kind?: "checkpoint" | "safety";
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
	/**
	 * Called with each newly captured checkpoint, before `captureIfChanged`
	 * returns. The extension runner uses this to dispatch `checkpoint_created`
	 * (R42-RWD.8). Deduplicated captures and pre-rewind safety snapshots do not
	 * fire it — only real, new turn checkpoints do.
	 */
	onCaptured?: (record: CheckpointRecord) => void | Promise<void>;
}

/**
 * Outcome of a working-tree restore.
 *
 * - `restored` — the tree now matches the target snapshot.
 * - `unchanged` — the tree already matched it; nothing was written or deleted.
 * - `rolled-back` — the restore failed part-way and the tree was returned to
 *   the pre-rewind safety snapshot.
 * - `unrecoverable` — the restore failed *and* the rollback failed; both refs
 *   are reported on the result so no state is lost.
 * - `disabled` — the cwd is not inside a git repository.
 * - `failed` — the restore could not start; nothing was mutated.
 */
export type CheckpointRestoreStatus =
	| "restored"
	| "unchanged"
	| "rolled-back"
	| "unrecoverable"
	| "disabled"
	| "failed";

export interface CheckpointRestoreOptions {
	/** Entry id whose checkpoint the working tree is restored to. */
	targetEntryId: string;
	/**
	 * Current session leaf. The pre-rewind safety snapshot is recorded against
	 * it, so rewinding back to this entry redoes the abandoned state.
	 */
	currentEntryId: string;
	/**
	 * Invoked after each individual path is written or deleted. Progress seam
	 * for the UI, and the failure-injection seam for tests: throwing from it
	 * aborts the restore and triggers the rollback to the safety snapshot.
	 */
	onPathRestored?: (path: string) => void | Promise<void>;
}

export interface CheckpointRestoreResult {
	status: CheckpointRestoreStatus;
	/** Paths written out of the target snapshot and kept. */
	restored: string[];
	/** Paths deleted because the target snapshot does not contain them. */
	deleted: string[];
	/** The pre-rewind safety snapshot, once one could be captured. */
	safety?: CheckpointRecord;
	/** The checkpoint that was restored to, once it could be resolved. */
	target?: CheckpointRecord;
	/** Why the restore did not complete. Set for every status but `restored`/`unchanged`. */
	reason?: string;
	/** Why the rollback failed. Only ever set together with status `unrecoverable`. */
	rollbackReason?: string;
}

export interface CheckpointRewindOptions extends CheckpointRestoreOptions {
	/**
	 * Moves the conversation leaf (`AgentSession.navigateTree`). Invoked only
	 * after the file restore has succeeded — see R42-RWD.5.
	 */
	navigate: () => void | Promise<void>;
}

export interface CheckpointRewindResult {
	/** Result of the file half. */
	restore: CheckpointRestoreResult;
	/** Whether `navigate()` ran — i.e. whether the file restore succeeded. */
	navigated: boolean;
	/** Set when `navigate()` itself threw; the files are already restored. */
	navigateReason?: string;
}

/** Paths to write out of a tree and paths to delete, derived from a tree-to-tree diff. */
interface TreeDiff {
	writes: string[];
	deletes: string[];
	/**
	 * The subset of `writes` that is absent from the *source* tree (diff status
	 * `A`). Used only by the pre-flight safety checks: a path the source
	 * snapshot does not contain is a path that snapshot cannot restore, so
	 * writing over it when it exists on disk would destroy uncaptured content.
	 */
	added: string[];
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

/** Raw stdout, untrimmed — required for `-z` output whose records end in NUL. */
async function gitRaw(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
	return (await gitRaw(cwd, args, extraEnv)).trim();
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
/**
 * A fresh id for one snapshot: sortable-ish prefix, random suffix, and safe to
 * paste straight into a ref name (`sanitizeRefComponent` leaves it untouched).
 */
function newRecoveryId(): string {
	return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function sanitizeRefComponent(value: string): string {
	let out = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
	out = out.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
	if (out.endsWith(".lock")) out = `${out.slice(0, -".lock".length)}-lock`;
	return out.length > 0 ? out : "checkpoint";
}

/**
 * Diff two snapshot trees into the paths a restore has to write and the paths
 * it has to delete. `--no-renames` keeps every record a plain status/path pair;
 * `-z` keeps paths literal so filenames with spaces or newlines survive.
 */
async function diffTrees(top: string, fromTree: string, toTree: string): Promise<TreeDiff> {
	const raw = await gitRaw(top, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", fromTree, toTree]);
	const tokens = raw.split("\0");
	const diff: TreeDiff = { writes: [], deletes: [], added: [] };
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		const status = tokens[i];
		const path = tokens[i + 1];
		if (status.length === 0 || path.length === 0) continue;
		// D = present in `fromTree`, absent in `toTree`. Everything else
		// (A/M/T) exists in `toTree` and has to be written out of it.
		if (status.startsWith("D")) {
			diff.deletes.push(path);
			continue;
		}
		diff.writes.push(path);
		if (status.startsWith("A")) diff.added.push(path);
	}
	return diff;
}

/** Path arguments per git invocation, so a huge diff cannot overflow ARG_MAX. */
const GIT_PATH_BATCH = 200;

/** Ignore-rule file that can live inside a snapshot tree. */
const IGNORE_RULE_FILE = ".gitignore";

/** Directory entries, or none when the directory cannot be read. */
function readDirEntries(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `lstat`-based existence: a dangling symlink exists for our purposes. */
function pathExists(full: string): boolean {
	try {
		lstatSync(full);
		return true;
	} catch {
		return false;
	}
}

/** Quote at most five paths for a refusal message. */
function formatPathList(paths: readonly string[]): string {
	const shown = paths.slice(0, 5).map((path) => `"${path}"`);
	const rest = paths.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * Object type (`blob`, `tree`, `commit`) of each given path in a tree; paths
 * absent from the tree are absent from the map. `ls-tree` resolves exact paths
 * without `-r`, so the cost tracks the paths asked about, not the tree size.
 */
async function treeEntryTypes(top: string, tree: string, paths: readonly string[]): Promise<Map<string, string>> {
	const types = new Map<string, string>();
	for (let i = 0; i < paths.length; i += GIT_PATH_BATCH) {
		// Literal pathspecs: a path containing `*` or `[` is a filename here,
		// never a glob.
		const raw = await gitRaw(top, ["ls-tree", "-z", tree, "--", ...paths.slice(i, i + GIT_PATH_BATCH)], {
			GIT_LITERAL_PATHSPECS: "1",
		});
		for (const record of raw.split("\0")) {
			// "<mode> SP <type> SP <object> TAB <path>"
			const tab = record.indexOf("\t");
			if (tab < 0) continue;
			const type = record.slice(0, tab).split(" ")[1];
			if (type) types.set(record.slice(tab + 1), type);
		}
	}
	return types;
}

/**
 * The shallowest directory at or under `full` that is a git repository, or
 * undefined when there is none. `.git` is a directory in a clone and a file in
 * a linked worktree, so both shapes count.
 */
function findGitRepositoryUnder(full: string): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(full);
	} catch {
		return undefined;
	}
	if (!stat.isDirectory()) return undefined;

	// Breadth-first, so the reported path is the shallowest repository found.
	const queue = [full];
	while (queue.length > 0) {
		const dir = queue.shift() as string;
		const entries = readDirEntries(dir);
		if (entries.some((entry) => entry.name === ".git")) return dir;
		// Symlinked directories are not descended: git never snapshotted
		// through them, so a restore cannot have scheduled anything inside.
		for (const entry of entries) if (entry.isDirectory()) queue.push(join(dir, entry.name));
	}
	return undefined;
}

/**
 * Paths scheduled for deletion that are — or contain — a nested git repository.
 *
 * `git add -A` collapses an embedded clone or a `git worktree add` checkout
 * into a single gitlink entry, so deleting OR overwriting that one path takes the nested
 * repository's `.git` with it: its committed history and any uncommitted work
 * are destroyed, and no snapshot holds either (a gitlink records only a commit
 * id). There is no safe way to put that back, so a restore that would do it is
 * refused rather than attempted.
 */
async function findNestedRepositories(top: string, fromTree: string, paths: readonly string[]): Promise<string[]> {
	if (paths.length === 0) return [];
	const root = resolve(top);
	const types = await treeEntryTypes(top, fromTree, paths);
	const found: string[] = [];
	for (const path of paths) {
		// A gitlink ("commit") entry is a nested repository by definition.
		if (types.get(path) === "commit" || findGitRepositoryUnder(join(root, path)) !== undefined) found.push(path);
	}
	return found;
}

/**
 * Paths the restore would create that already exist on disk while being absent
 * from the pre-rewind snapshot.
 *
 * The safety snapshot images everything git can see, so an existing path it
 * does not contain is content no snapshot holds — an ignored file, most often,
 * which is precisely what happens when `.gitignore` changed between capture
 * and restore. Overwriting it is unrecoverable, so the restore is refused.
 */
function findUncapturedWrites(top: string, added: readonly string[]): string[] {
	const root = resolve(top);
	return added.filter((path) => pathExists(join(root, path)));
}

/**
 * Ignore-rule files that differ between the two snapshots. The "ignored files
 * are never in a snapshot, never in the diff, never touched" invariant only
 * holds while the rules are the same at capture and at restore; when they
 * drift, a path can be tracked in one snapshot and ignored in the other and so
 * be deleted although the user believes it is ignored. Detected, not guessed
 * at: a drifting rule set with deletions pending is refused.
 */
function findIgnoreRuleDrift(diff: TreeDiff): string[] {
	return [...diff.writes, ...diff.deletes].filter((path) => basename(path) === IGNORE_RULE_FILE);
}

/**
 * Pre-flight refusal check, run after the safety snapshot and before the first
 * mutation. Returns the refusal message, or undefined when the restore is safe
 * to apply. Fails closed by design: every case here is one where proceeding
 * could destroy content no snapshot can bring back.
 */
async function findRestoreHazard(top: string, fromTree: string, diff: TreeDiff): Promise<string | undefined> {
	// Every mutated path, not just deletes: a nested repository sitting where the
	// target tree holds a blob diffs as a typechange and lands in `writes`, where
	// `git checkout-index -f` destroys it exactly as a delete would.
	const nested = await findNestedRepositories(top, fromTree, [...diff.deletes, ...diff.writes]);
	if (nested.length > 0) {
		return `refusing to restore: ${formatPathList(nested)} would be removed or overwritten, and that is a nested git repository (or a directory holding one) — doing so would take its history and any uncommitted work with it, and no snapshot holds either. Move or remove it yourself, then rewind again.`;
	}

	const uncaptured = findUncapturedWrites(top, diff.added);
	if (uncaptured.length > 0) {
		return `refusing to restore: ${formatPathList(uncaptured)} exists in the working tree but is in no snapshot (ignored, or otherwise invisible to git), so restoring would overwrite content nothing can bring back. Move it aside, or stop ignoring it so it gets snapshotted, then rewind again.`;
	}

	const drift = findIgnoreRuleDrift(diff);
	if (drift.length > 0 && diff.deletes.length > 0) {
		return `refusing to restore: the ignore rules in ${formatPathList(drift)} differ between this checkpoint and the working tree, so a file that is ignored in one snapshot and tracked in the other could be deleted. Undo the ignore-rule change first, or rewind with "Conversation only".`;
	}

	return undefined;
}

/** Remove a worktree path and any directories the removal left empty. */
function deleteWorktreePath(top: string, path: string): void {
	// `git rev-parse --show-toplevel` reports forward slashes even on Windows;
	// resolve so the prune loop compares like-for-like separators.
	const root = resolve(top);
	const full = join(root, path);
	// Last line of defence for the one call that recursively deletes: a nested
	// git repository must never be removed, because nothing snapshots it. The
	// restore refuses long before this (`findNestedRepositories`); reaching
	// here means the tree changed under us, so abort and let the caller roll
	// back rather than delete a repository.
	const nested = findGitRepositoryUnder(full);
	if (nested !== undefined) {
		throw new Error(`refusing to delete "${path}": ${nested} is a git repository and no snapshot holds it`);
	}
	rmSync(full, { force: true, recursive: true });
	// Prune the directories the removal emptied, the way git's own checkout does.
	for (let dir = dirname(full); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
		try {
			if (readdirSync(dir).length > 0) break;
			rmdirSync(dir);
		} catch {
			break;
		}
	}
}

/**
 * Apply a tree diff to the working tree, writing the `writes` paths out of
 * `sourceTree` through a throwaway index. Deletions run first: a path can be a
 * file in one tree and a directory in the other, and clearing the old shape
 * first keeps the checkout from colliding with it.
 */
async function applyTreeDiff(
	top: string,
	sourceTree: string,
	diff: TreeDiff,
	onPathRestored?: (path: string) => void | Promise<void>,
): Promise<void> {
	for (const path of diff.deletes) {
		deleteWorktreePath(top, path);
		await onPathRestored?.(path);
	}
	if (diff.writes.length === 0) return;

	const indexDir = mkdtempSync(join(tmpdir(), "draht-checkpoint-restore-"));
	try {
		const indexEnv = { ...CHECKPOINT_IDENTITY, GIT_INDEX_FILE: join(indexDir, "index") };
		await git(top, ["read-tree", sourceTree], indexEnv);
		for (const path of diff.writes) {
			// `-f` overwrites an existing file and creates missing parent
			// directories; the user's own index is untouched throughout.
			await git(top, ["checkout-index", "-f", "-u", "--", path], indexEnv);
			await onPathRestored?.(path);
		}
	} finally {
		rmSync(indexDir, { recursive: true, force: true });
	}
}

/** Path of the checkpoint metadata sidecar for a session file. */
export function checkpointSidecarPath(sessionFile: string): string {
	return `${sessionFile}.checkpoints.jsonl`;
}

/**
 * Name of the in-progress marker, written inside the repository's git
 * directory (per worktree, like the rest of git's own state) so it is found
 * again from any session that opens the same tree.
 */
export const RESTORE_MARKER_FILE = "draht-restore-in-progress.json";

/** A restore that started and never finished — a crash or a kill mid-restore. */
export interface InterruptedRestore {
	/** Absolute path of the marker file, so a message can tell the user what to delete. */
	markerPath: string;
	/** Ref of the pre-rewind safety snapshot that recovers the tree. Empty when the marker is unreadable. */
	safetyRef: string;
	/** Recovery id addressing that safety snapshot through `getRecoveryPoint`. */
	safetyRecoveryId?: string;
	/** Ref of the snapshot the interrupted restore was moving towards. */
	targetRef?: string;
	targetEntryId?: string;
	currentEntryId?: string;
	/** ISO-8601 start time of the interrupted restore. */
	startedAt?: string;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the marker, if there is one. A marker that exists but cannot be parsed
 * still reports an interrupted restore — its presence is the signal; its
 * contents are only the detail — so corruption can never downgrade to "fine".
 */
function readRestoreMarker(markerPath: string): InterruptedRestore | undefined {
	if (!existsSync(markerPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
		return {
			markerPath,
			safetyRef: stringOrUndefined(parsed.safetyRef) ?? "",
			safetyRecoveryId: stringOrUndefined(parsed.safetyRecoveryId),
			targetRef: stringOrUndefined(parsed.targetRef),
			targetEntryId: stringOrUndefined(parsed.targetEntryId),
			currentEntryId: stringOrUndefined(parsed.currentEntryId),
			startedAt: stringOrUndefined(parsed.startedAt),
		};
	} catch {
		return { markerPath, safetyRef: "" };
	}
}

function writeRestoreMarker(markerPath: string, marker: Omit<InterruptedRestore, "markerPath">): void {
	mkdirSync(dirname(markerPath), { recursive: true });
	writeFileSync(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
}

function clearRestoreMarker(markerPath: string): void {
	rmSync(markerPath, { force: true });
}

/** The message shown when a previous restore is found to have been interrupted. */
export function describeInterruptedRestore(marker: InterruptedRestore): string {
	const recovery =
		marker.safetyRef.length > 0
			? `Your pre-rewind files are snapshotted at ${marker.safetyRef} — recover them with \`git checkout ${marker.safetyRef} -- .\``
			: "The marker could not be read, so the safety ref is unknown — look for one under refs/draht/checkpoints/";
	const started = marker.startedAt ? ` (started ${marker.startedAt})` : "";
	return `refusing to restore: a previous restore was interrupted${started} and the working tree may be between two snapshots. ${recovery}. Delete ${marker.markerPath} once the tree is the way you want it.`;
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
	const record: CheckpointRecord = {
		entryId: candidate.entryId,
		ref: candidate.ref,
		treeHash: candidate.treeHash,
		timestamp: candidate.timestamp,
		dirtyFileCount: candidate.dirtyFileCount,
	};
	// Optional: sidecars written before recovery ids existed stay readable.
	if (typeof candidate.recoveryId === "string") record.recoveryId = candidate.recoveryId;
	if (candidate.kind === "safety" || candidate.kind === "checkpoint") record.kind = candidate.kind;
	return record;
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
	private readonly onCaptured?: (record: CheckpointRecord) => void | Promise<void>;

	constructor(options: CheckpointManagerOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.sidecarPath = checkpointSidecarPath(options.sessionFile);
		this.onCaptured = options.onCaptured;
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

		try {
			const treeHash = await this.writeTreeSnapshot();

			const previous = this.list().at(-1);
			if (previous?.treeHash === treeHash) return { status: "deduplicated" };

			const recoveryId = newRecoveryId();
			const base = `${CHECKPOINT_REF_PREFIX}/${sanitizeRefComponent(this.sessionId)}/${sanitizeRefComponent(entryId)}`;
			// A second capture for the same entry id (a retried or re-entered
			// turn) must not overwrite the first: `update-ref` would drop the
			// only anchor of a tree the user can still rewind to. Suffix
			// instead, and let the sidecar order decide which one `get` returns.
			const ref = (await this.refExists(base)) ? `${base}-${recoveryId}` : base;
			await this.anchorTree(treeHash, ref, `draht checkpoint ${entryId}`);
			const record = await this.recordSnapshot(entryId, ref, treeHash, recoveryId, "checkpoint");
			try {
				await this.onCaptured?.(record);
			} catch {
				// A listener failure never turns a captured checkpoint into a failed one.
			}
			return { status: "created", record };
		} catch (error) {
			return { status: "failed", reason: describeError(error) };
		}
	}

	/**
	 * Snapshot the working tree into a throwaway index and return its tree
	 * hash. A private index keeps `add -A` off the user's real index entirely,
	 * and `add -A` honours `.gitignore` for *untracked* files, so ignored files
	 * never enter a snapshot — and therefore can never be restored or deleted
	 * by a rewind.
	 *
	 * The throwaway index is seeded from the user's real one first. Ignore
	 * rules never apply to a path git already tracks, so seeding is what keeps
	 * a tracked-but-ignored file (`git add -f secret.env` with `secret.env` in
	 * `.gitignore`) inside the snapshot: from an empty index every path looks
	 * untracked, and such files silently fell out of every snapshot while
	 * restores still reported success.
	 */
	private async writeTreeSnapshot(): Promise<string> {
		const indexDir = mkdtempSync(join(tmpdir(), "draht-checkpoint-index-"));
		try {
			const indexFile = join(indexDir, "index");
			const indexEnv = { ...CHECKPOINT_IDENTITY, GIT_INDEX_FILE: indexFile };
			await this.seedSnapshotIndex(indexFile, indexEnv);
			await git(this.cwd, ["add", "-A"], indexEnv);
			return await git(this.cwd, ["write-tree"], indexEnv);
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}
	}

	/**
	 * Copy the user's index into the throwaway one so its tracked set carries
	 * over. Read-only with respect to the real index — it is copied, never
	 * written back, and `git rev-parse --git-path index` resolves the effective
	 * index (split-index links resolve against the git dir, so a copy still
	 * reads). Falls back to `read-tree HEAD`, whose tracked set is the next
	 * best answer, and to an empty index when HEAD is unborn — where nothing is
	 * tracked and empty is the correct answer.
	 */
	private async seedSnapshotIndex(indexFile: string, indexEnv: Record<string, string>): Promise<void> {
		try {
			const realIndex = resolve(this.cwd, await git(this.cwd, ["rev-parse", "--git-path", "index"]));
			if (existsSync(realIndex)) {
				copyFileSync(realIndex, indexFile);
				return;
			}
		} catch {
			// Fall through to the HEAD-based seed.
		}
		try {
			await git(this.cwd, ["read-tree", "HEAD"], indexEnv);
		} catch {
			// Unborn HEAD: nothing is tracked, so the empty index is correct.
		}
	}

	/** Whether a ref already exists, without throwing for the common "it does not" case. */
	private async refExists(ref: string): Promise<boolean> {
		try {
			await git(this.cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
			return true;
		} catch {
			return false;
		}
	}

	/** Absolute path of this repository's in-progress restore marker. */
	private async restoreMarkerPath(): Promise<string> {
		return join(resolve(this.cwd, await git(this.cwd, ["rev-parse", "--git-dir"])), RESTORE_MARKER_FILE);
	}

	/** Anchor a tree behind a commit at `ref` so it survives GC. */
	private async anchorTree(treeHash: string, ref: string, message: string): Promise<void> {
		const commit = await git(this.cwd, ["commit-tree", treeHash, "-m", message], CHECKPOINT_IDENTITY);
		await git(this.cwd, ["update-ref", ref, commit], CHECKPOINT_IDENTITY);
	}

	/** Append the sidecar record for an anchored snapshot. */
	private async recordSnapshot(
		entryId: string,
		ref: string,
		treeHash: string,
		recoveryId: string,
		kind: "checkpoint" | "safety",
	): Promise<CheckpointRecord> {
		const record: CheckpointRecord = {
			entryId,
			ref,
			treeHash,
			timestamp: new Date().toISOString(),
			dirtyFileCount: await this.countDirtyFiles(treeHash),
			recoveryId,
			kind,
		};
		appendCheckpointRecord(this.sidecarPath, record);
		return record;
	}

	/**
	 * Capture the pre-rewind safety snapshot (R42-RWD.3). Unlike
	 * `captureIfChanged` this never dedups — the rewind must always have an
	 * anchored ref to roll back to — and it never reuses the plain checkpoint
	 * ref name, so an existing checkpoint for the same entry id is preserved.
	 * The record is keyed to the current leaf so that rewinding back to it is
	 * a redo of the abandoned state.
	 */
	private async captureSafetySnapshot(entryId: string): Promise<CheckpointRecord> {
		const treeHash = await this.writeTreeSnapshot();
		const recoveryId = newRecoveryId();
		const ref = `${CHECKPOINT_REF_PREFIX}/${sanitizeRefComponent(this.sessionId)}/${SAFETY_REF_SEGMENT}-${sanitizeRefComponent(entryId)}-${recoveryId}`;
		await this.anchorTree(treeHash, ref, `draht pre-rewind snapshot ${entryId}`);
		return await this.recordSnapshot(entryId, ref, treeHash, recoveryId, "safety");
	}

	/**
	 * Restore the working tree to the checkpoint recorded for `targetEntryId`
	 * (R42-RWD.3, R42-RWD.4).
	 *
	 * Ordering is fixed: a safety snapshot of the current tree is captured and
	 * anchored *before* anything is mutated, then the two snapshot trees are
	 * diffed and only the differing paths are touched — differing paths are
	 * checked out of the target snapshot, paths absent from it are deleted.
	 * Deliberately not `git stash apply` and not `git checkout -- .`: both
	 * clobber untracked and ignored state. Ignored files are never in a
	 * snapshot, so they are never in the diff and never touched.
	 *
	 * Before the first mutation the diff is checked for the cases where that
	 * reasoning does not hold, and the whole restore is refused (`failed`,
	 * nothing touched) rather than applied part-way:
	 * - a path to delete that is, or contains, a nested git repository;
	 * - a path to create that already exists on disk yet is in no snapshot;
	 * - ignore rules that differ between the snapshots while deletions pend.
	 * A refusal is recoverable, a deletion is not.
	 *
	 * Any failure after the first mutation rolls the tree back to the safety
	 * snapshot; if that rollback also fails, both refs are reported on the
	 * result rather than left implicit. An in-progress marker in the git dir
	 * names the safety ref for as long as the tree is being mutated, so an
	 * interrupted restore is never silent. Never throws.
	 */
	async restore(options: CheckpointRestoreOptions): Promise<CheckpointRestoreResult> {
		const untouched = { restored: [] as string[], deleted: [] as string[] };
		if (!(await isGitRepository(this.cwd))) {
			return { status: "disabled", ...untouched, reason: `${this.cwd} is not inside a git repository` };
		}

		// Resolved before the safety snapshot is recorded, so the lookup cannot
		// pick up the safety record this call is about to append. A recovery id
		// addresses one specific snapshot, which is the only way to reach a
		// safety snapshot that a later rewind from the same leaf shadows.
		const target = this.get(options.targetEntryId) ?? this.getRecoveryPoint(options.targetEntryId);
		if (!target) {
			return { status: "failed", ...untouched, reason: `no checkpoint recorded for entry ${options.targetEntryId}` };
		}

		let top: string;
		let markerPath: string;
		let targetTree: string;
		let safety: CheckpointRecord;
		try {
			// Plumbing below addresses index paths, which are relative to the
			// repository root rather than to this manager's cwd.
			top = await git(this.cwd, ["rev-parse", "--show-toplevel"]);
			markerPath = await this.restoreMarkerPath();
			// A marker still on disk means a previous restore never finished, so
			// the tree is somewhere between two snapshots and diffing against a
			// fresh snapshot of it would bake that half-state in. Refuse, and
			// name the ref that recovers the tree.
			const interrupted = readRestoreMarker(markerPath);
			if (interrupted) {
				return { status: "failed", ...untouched, target, reason: describeInterruptedRestore(interrupted) };
			}
			// Resolve through the ref so a pruned or corrupt snapshot fails here,
			// before the safety snapshot and before any mutation.
			targetTree = await git(top, ["rev-parse", "--verify", `${target.ref}^{tree}`]);
			safety = await this.captureSafetySnapshot(options.currentEntryId);
		} catch (error) {
			return { status: "failed", ...untouched, target, reason: describeError(error) };
		}

		if (targetTree === safety.treeHash) {
			return { status: "unchanged", ...untouched, safety, target };
		}

		let diff: TreeDiff;
		let hazard: string | undefined;
		try {
			diff = await diffTrees(top, safety.treeHash, targetTree);
			// Every hazard here is content the snapshots cannot bring back, so
			// the restore is refused whole rather than applied part-way. Nothing
			// has been mutated at this point.
			hazard = await findRestoreHazard(top, safety.treeHash, diff);
		} catch (error) {
			return { status: "failed", ...untouched, safety, target, reason: describeError(error) };
		}
		if (hazard) {
			return { status: "failed", ...untouched, safety, target, reason: hazard };
		}

		try {
			// Written before the first mutation so an interrupted restore — a
			// SIGINT, a crash, a pulled plug — leaves behind the name of the ref
			// that recovers the tree. Cancellation itself is out of scope; this
			// only guarantees the interruption is never silent.
			writeRestoreMarker(markerPath, {
				safetyRef: safety.ref,
				safetyRecoveryId: safety.recoveryId,
				targetRef: target.ref,
				targetEntryId: options.targetEntryId,
				currentEntryId: options.currentEntryId,
				startedAt: new Date().toISOString(),
			});
		} catch (error) {
			return {
				status: "failed",
				...untouched,
				safety,
				target,
				reason: `could not write the restore marker at ${markerPath}: ${describeError(error)}`,
			};
		}

		try {
			await applyTreeDiff(top, targetTree, diff, options.onPathRestored);
			clearRestoreMarker(markerPath);
			return { status: "restored", restored: diff.writes, deleted: diff.deletes, safety, target };
		} catch (error) {
			const reason = describeError(error);
			try {
				// The inverse diff covers exactly the paths the forward pass could
				// have touched, and re-applying it is idempotent for the ones it
				// never reached.
				const inverse = await diffTrees(top, targetTree, safety.treeHash);
				await applyTreeDiff(top, safety.treeHash, inverse);
				clearRestoreMarker(markerPath);
				return { status: "rolled-back", ...untouched, safety, target, reason };
			} catch (rollbackError) {
				// Marker deliberately left in place: the tree really is between
				// two snapshots, and the next restore has to say so.
				return {
					status: "unrecoverable",
					...untouched,
					safety,
					target,
					reason,
					rollbackReason: describeError(rollbackError),
				};
			}
		}
	}

	/**
	 * Restore files and then move the conversation leaf, in that order
	 * (R42-RWD.5). `navigate` runs only once the file restore has succeeded,
	 * so a caller cannot move the leaf ahead of the working tree. Never throws.
	 */
	async rewind(options: CheckpointRewindOptions): Promise<CheckpointRewindResult> {
		const { navigate, ...restoreOptions } = options;
		const restore = await this.restore(restoreOptions);
		if (restore.status !== "restored" && restore.status !== "unchanged") {
			return { restore, navigated: false };
		}
		try {
			await navigate();
			return { restore, navigated: true };
		} catch (error) {
			return { restore, navigated: false, navigateReason: describeError(error) };
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

	/**
	 * The one snapshot with this recovery id. `get` answers "the newest
	 * snapshot for this entry", which by design shadows older ones — two
	 * rewinds from the same leaf record two safety snapshots under the same
	 * entry id. This addresses a single snapshot, so no recovery point is ever
	 * unreachable, and `restore` accepts a recovery id wherever it accepts an
	 * entry id.
	 */
	getRecoveryPoint(recoveryId: string): CheckpointRecord | undefined {
		return this.list().find((record) => record.recoveryId === recoveryId);
	}

	/** Every pre-rewind safety snapshot, oldest first — the undo history of `/rewind`. */
	listSafetySnapshots(): CheckpointRecord[] {
		return this.list().filter((record) => record.kind === "safety");
	}

	/**
	 * The marker left behind by a restore that never finished, if there is one
	 * (D5). Call it at startup to tell the user which ref recovers their tree;
	 * `restore` refuses while it is present. Clearing it is the user's decision
	 * (`clearInterruptedRestore`), because only they know whether the tree is
	 * the way they want it.
	 */
	static async findInterruptedRestore(cwd: string): Promise<InterruptedRestore | undefined> {
		if (!(await isGitRepository(cwd))) return undefined;
		try {
			return readRestoreMarker(join(resolve(cwd, await git(cwd, ["rev-parse", "--git-dir"])), RESTORE_MARKER_FILE));
		} catch {
			return undefined;
		}
	}

	/** Acknowledge an interrupted restore, re-enabling `restore`. Returns whether a marker was cleared. */
	static async clearInterruptedRestore(cwd: string): Promise<boolean> {
		const marker = await CheckpointManager.findInterruptedRestore(cwd);
		if (!marker) return false;
		clearRestoreMarker(marker.markerPath);
		return true;
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
