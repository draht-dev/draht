import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStore } from "../../src/harness/session/jsonl-repo.ts";
import { MemorySessionStore } from "../../src/harness/session/memory-repo.ts";
import { SessionRepo } from "../../src/harness/session/repo-utils.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("MemorySessionStore", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new SessionRepo({ storage: new MemorySessionStore() });
		const session = await repo.storage.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		await expect((await repo.storage.open(metadata)).getMetadata()).resolves.toEqual(metadata);
		expect((await repo.storage.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.storage.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.storage.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.storage.delete(metadata);
		await expect(repo.storage.open(metadata)).rejects.toThrow("Session not found: session-1");
	});
});

describe("JsonlSessionStore", () => {
	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new SessionRepo({ storage: new JsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const session = await repo.storage.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.storage.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.storage.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.storage.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SessionRepo({ storage: new JsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.storage.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.storage.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.storage.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.storage.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.storage.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.storage.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("persists header metadata through create, list, and fork", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SessionRepo({ storage: new JsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.storage.create({
			cwd: "/tmp/source",
			id: "source-session",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.storage.list({ cwd: "/tmp/source" })).map((listed) => listed.metadata)).toEqual([
			{ profile: "reviewer" },
		]);
		const fork = await repo.storage.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session" });
		expect((await fork.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const overridden = await repo.storage.fork(sourceMetadata, {
			cwd: "/tmp/target",
			id: "overridden-session",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({ profile: "writer" });
	});
});
