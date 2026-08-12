import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The engine's install root: everything the engine itself writes (state,
 * journal, cache, staging, backups) lives under this directory. Component
 * payload TARGET directories are a separate concern — callers pass those in
 * explicitly (see `executor.ts`'s `materialize`), they are never derived
 * from this root.
 */
export function resolveInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.DRAHT_INSTALL_DIR;
	if (override) return override;
	return join(homedir(), ".draht", "install");
}

/** The durable state document: `loadState`/`saveState` in `state.ts`. */
export function statePath(root: string): string {
	return join(root, "state.json");
}

/** The append-only transaction journal: `appendJournal`/`readJournal` in `journal.ts`. */
export function journalPath(root: string): string {
	return join(root, "journal.jsonl");
}

/** Downloaded/verified package payload cache, keyed and populated by callers of a later phase. */
export function cacheDir(root: string): string {
	return join(root, "cache");
}

/** Parent of every transaction's staging working directory. */
export function stagingRootDir(root: string): string {
	return join(root, "staging");
}

/** Parent of every transaction's backups working directory. */
export function backupsRootDir(root: string): string {
	return join(root, "backups");
}

/** Working directory a transaction stages new component payloads into before swapping them into place. */
export function stagingDir(root: string, tx: string): string {
	return join(stagingRootDir(root), tx);
}

/** Working directory a transaction moves a component's previous target directory into before swapping. */
export function backupsDir(root: string, tx: string): string {
	return join(backupsRootDir(root), tx);
}
