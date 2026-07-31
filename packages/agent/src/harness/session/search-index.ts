import type { SessionMetadata, SessionSearchIndex, SessionSnapshot } from "../types.ts";

export interface SessionSearchIndexSource<TMetadata extends SessionMetadata, TListOptions = void> {
	list(options?: TListOptions): Promise<TMetadata[]>;
	load(metadata: TMetadata): Promise<SessionSnapshot<TMetadata>>;
}

export async function rebuildSessionSearchIndex<TMetadata extends SessionMetadata, TListOptions>(
	source: SessionSearchIndexSource<TMetadata, TListOptions>,
	index: Pick<SessionSearchIndex<TMetadata>, "reset" | "replaceSession">,
	options?: TListOptions,
): Promise<void> {
	await index.reset();
	for (const metadata of await source.list(options)) {
		const snapshot = await source.load(metadata);
		await index.replaceSession(snapshot.metadata, snapshot.entries);
	}
}
