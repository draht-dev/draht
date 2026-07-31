import type { SessionMetadata, SessionSearchIndex, SessionSnapshot } from "../types.ts";

export interface SessionSearchIndexSource<TMetadata extends SessionMetadata, TListOptions = void> {
	list(options?: TListOptions): Promise<TMetadata[]>;
	load(metadata: TMetadata): Promise<SessionSnapshot<TMetadata>>;
}

export async function rebuildSessionSearchIndex<TMetadata extends SessionMetadata, TListOptions>(
	source: SessionSearchIndexSource<TMetadata, TListOptions>,
	index: Pick<SessionSearchIndex<TMetadata>, "replaceSession">,
	options?: TListOptions,
): Promise<void> {
	for (const metadata of await source.list(options)) {
		await index.replaceSession(metadata, (await source.load(metadata)).entries);
	}
}
