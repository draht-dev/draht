import type {
	SessionMetadata,
	SessionSearchIndexRecord,
	SessionSearchIndexWriter,
	SessionTreeEntry,
} from "../types.ts";

export function toSessionSearchIndexRecord<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entry: SessionTreeEntry,
): SessionSearchIndexRecord<TMetadata> {
	return { metadata, entry };
}

/** Delivers each lifecycle event to its targets, like Go's io.MultiWriter. */
export class MultiSessionSearchIndexWriter<TMetadata extends SessionMetadata>
	implements SessionSearchIndexWriter<TMetadata>
{
	private readonly writers: readonly SessionSearchIndexWriter<TMetadata>[];

	constructor(...writers: SessionSearchIndexWriter<TMetadata>[]) {
		this.writers = writers;
	}

	async write(record: SessionSearchIndexRecord<TMetadata>): Promise<void> {
		for (const writer of this.writers) await writer.write(record);
	}

	async remove(record: SessionSearchIndexRecord<TMetadata>): Promise<void> {
		for (const writer of this.writers) await writer.remove(record);
	}
}
