import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionStore } from "../../src/harness/session/jsonl-repo.ts";
import {
	createInMemorySessionStore,
	type InMemorySessionCreateOptions,
} from "../../src/harness/session/memory-repo.ts";
import { createSessionRepository } from "../../src/harness/session/repo-utils.ts";
import type { SessionMetadata, SessionStore } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

function createCountingInMemorySessionStore(): {
	store: SessionStore<SessionMetadata, InMemorySessionCreateOptions, void>;
	counter: { loadCount: number };
} {
	const source = createInMemorySessionStore();
	const counter = { loadCount: 0 };
	return {
		counter,
		store: {
			create: (options) => source.create(options),
			async load(metadata) {
				counter.loadCount += 1;
				return source.load(metadata);
			},
			list: (options) => source.list(options),
			getEntries: (metadata, options) => source.getEntries(metadata, options),
			createEntryId: (metadata) => source.createEntryId(metadata),
			appendEntry: (metadata, entry) => source.appendEntry(metadata, entry),
			setLeafId: (metadata, leafId) => source.setLeafId(metadata, leafId),
			delete: (metadata) => source.delete(metadata),
			fork: (metadata, options) => source.fork(metadata, options),
		},
	};
}

describe("InMemorySessionStore", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = createSessionRepository({ store: createInMemorySessionStore() });
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		await expect((await repo.open(metadata)).getMetadata()).resolves.toEqual(metadata);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});

	it("does not repeatedly load full snapshots for scoped reads", async () => {
		const { store, counter } = createCountingInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const session = await repo.create({ id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("one"));

		counter.loadCount = 0;
		await session.getMetadata();
		expect(counter.loadCount).toBe(0);

		await session.getLeafId();
		expect(counter.loadCount).toBe(1);

		counter.loadCount = 0;
		await session.getEntry(entryId);
		expect(counter.loadCount).toBe(1);
	});
});

describe("JsonlSessionStore", () => {
	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("persists header metadata through create, list, and fork", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.create({
			cwd: "/tmp/source",
			id: "source-session",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.list({ cwd: "/tmp/source" })).map((listed) => listed.metadata)).toEqual([
			{ profile: "reviewer" },
		]);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session" });
		expect((await fork.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const overridden = await repo.fork(sourceMetadata, {
			cwd: "/tmp/target",
			id: "overridden-session",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({ profile: "writer" });
	});
});
