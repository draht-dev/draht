import type { SessionMetadata, SessionSearchIndexRecord, SessionTreeEntry } from "../types.ts";

export function toSessionSearchIndexRecord<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entry: SessionTreeEntry,
): SessionSearchIndexRecord<TMetadata> {
	return { metadata, entry };
}
