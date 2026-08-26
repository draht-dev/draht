import type { AgentMessage } from "../../types.ts";
import type { HarnessEvent } from "../agent-harness.ts";
import type { Context } from "../context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { Entry, SessionReader } from "../session/types.ts";
import { pendingEntry } from "../session/values.ts";

export function chainEntries<T extends { id: string }>(
	parentId: string | null,
	items: readonly T[],
): Array<T & { parentId: string | null }> {
	return items.map((item) => {
		const entry = { ...item, parentId };
		parentId = item.id;
		return entry;
	});
}

export function entryLifecycleEvents(entry: Entry, lane: string, runId: string): HarnessEvent[] {
	return entry.type === "message"
		? [
				{ type: "message_start", lane, runId, message: entry.message },
				{ type: "message_end", lane, runId, message: entry.message, entryId: entry.id },
				{ type: "entry_added", lane, entry },
			]
		: [{ type: "entry_added", lane, entry }];
}

export function readPendingMessages(
	reader: SessionReader,
	ids: readonly string[],
	description: string,
	context: Context,
): Promise<Array<{ entryId: string; message: AgentMessage }>> {
	return Promise.all(
		ids.map(async (entryId) => {
			const value = await reader.getValue(pendingEntry(entryId), context);
			if (value?.value.type !== "message") {
				throw new SessionInvariantError(`${description} ${entryId} is missing its message payload`);
			}
			return { entryId, message: value.value.payload };
		}),
	);
}
