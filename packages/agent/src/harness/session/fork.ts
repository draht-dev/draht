import type { SessionForkOptions, SessionForkSelection, SessionTreeEntry } from "../types.ts";
import { SessionError } from "../types.ts";

type MaybePromise<T> = T | Promise<T>;

interface SessionForkEntrySource {
	readEntry(id: string): MaybePromise<SessionTreeEntry | undefined>;
	readEntries(): MaybePromise<readonly SessionTreeEntry[]>;
	readPathToRootOrCompaction(leafId: string | null): MaybePromise<readonly SessionTreeEntry[]>;
}

export function createSessionForkSelection(options: SessionForkOptions): SessionForkSelection {
	if (!options.entryId) return { kind: "all" };
	return (options.position ?? "before") === "at"
		? { kind: "through_entry", entryId: options.entryId }
		: { kind: "before_user_message", entryId: options.entryId };
}

/** @internal Shared fork selection validation for built-in collections. */
export async function readSessionEntriesForFork(
	source: SessionForkEntrySource,
	selection: SessionForkSelection,
): Promise<readonly SessionTreeEntry[]> {
	if (selection.kind === "all") return source.readEntries();
	const target = await source.readEntry(selection.entryId);
	if (!target) throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} not found`);
	if (selection.kind === "through_entry") return source.readPathToRootOrCompaction(target.id);
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} is not a user message`);
	}
	return source.readPathToRootOrCompaction(target.parentId);
}
