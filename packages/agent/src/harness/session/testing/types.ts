import type { SessionRepo, Storage } from "../types.ts";

/** A fresh backend storage instance owned by one conformance case. */
export interface StorageFixture extends AsyncDisposable {
	readonly storage: Storage;
}

/** Creates an isolated storage fixture for one conformance case. */
export type StorageFixtureFactory = () => Promise<StorageFixture>;

/** A runner-independent conformance case that can be registered with any test framework. */
export interface StorageConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}

/** A fresh repository instance owned by one conformance case. */
export interface SessionRepoFixture extends AsyncDisposable {
	readonly repo: SessionRepo;
	readonly storageVersion: number;
}

/** Creates an isolated repository fixture for one conformance case. */
export type SessionRepoFixtureFactory = () => Promise<SessionRepoFixture>;

/** A runner-independent conformance case for the SessionRepo contract. */
export type SessionRepoConformanceCase = StorageConformanceCase;
