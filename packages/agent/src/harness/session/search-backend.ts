import type { SessionMetadata, SessionSearchRecord, SessionSearchWriter, SessionTreeEntry } from "../types.ts";

export function toSessionSearchRecord<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entry: SessionTreeEntry,
): SessionSearchRecord<TMetadata> {
	return { metadata, entry };
}

/** Delivers each lifecycle event to its targets, like Go's io.MultiWriter. */
export class FanoutSessionSearchWriter<TMetadata extends SessionMetadata> implements SessionSearchWriter<TMetadata> {
	private readonly writers: readonly SessionSearchWriter<TMetadata>[];

	constructor(...writers: SessionSearchWriter<TMetadata>[]) {
		this.writers = writers;
	}

	async upsert(record: SessionSearchRecord<TMetadata>): Promise<void> {
		for (const writer of this.writers) await writer.upsert(record);
	}

	async remove(record: SessionSearchRecord<TMetadata>): Promise<void> {
		for (const writer of this.writers) await writer.remove(record);
	}
}
