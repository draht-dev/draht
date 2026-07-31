import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionStore } from "../../src/harness/session/jsonl-store.ts";
import {
	createInMemorySessionStore,
	type InMemorySessionCreateOptions,
} from "../../src/harness/session/memory-store.ts";
import { createSessionRepository } from "../../src/harness/session/repository.ts";
import type { SessionMetadata, SessionStore } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

class CountingReadEnv extends NodeExecutionEnv {
	readCount = 0;

	override async readTextFile(path: string, abortSignal?: AbortSignal) {
		this.readCount += 1;
		return super.readTextFile(path, abortSignal);
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class BlockingAppendEnv extends NodeExecutionEnv {
	readonly appendStarted = createDeferred();
	readonly releaseAppend = createDeferred();

	override async appendFile(path: string, content: string | Uint8Array) {
		this.appendStarted.resolve();
		await this.releaseAppend.promise;
		return super.appendFile(path, content);
	}
}

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
			appendEntry: (metadata, entry) => source.appendEntry(metadata, entry),
			delete: (metadata) => source.delete(metadata),
			fork: (metadata, options, entries) => source.fork(metadata, options, entries),
			[Symbol.asyncDispose]: () => source[Symbol.asyncDispose](),
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

	it("retains the opened aggregate instead of reloading for scoped reads", async () => {
		const { store, counter } = createCountingInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const session = await repo.create({ id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("one"));

		await session.getMetadata();
		await session.getLeafId();
		await session.getEntry(entryId);
		expect(counter.loadCount).toBe(0);
	});

	it("rejects repository operations and session writes after store disposal", async () => {
		const store = createInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const session = await repo.create({ id: "session-1" });
		await store[Symbol.asyncDispose]();

		await expect(repo.list()).rejects.toThrow("In-memory session store is disposed");
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow(
			"In-memory session store is disposed",
		);
	});

	it("supports lexical ownership with await using", async () => {
		let listDisposedStore: (() => Promise<SessionMetadata[]>) | undefined;
		{
			await using store = createInMemorySessionStore();
			const repository = createSessionRepository({ store });
			listDisposedStore = () => repository.list();
			await repository.create({ id: "session-1" });
		}

		await expect(listDisposedStore!()).rejects.toThrow("In-memory session store is disposed");
	});
});

describe("JsonlSessionStore", () => {
	it("waits for accepted appends before disposal and rejects later writes", async () => {
		const root = createTempDir();
		const env = new BlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const repo = createSessionRepository({ store });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const append = session.appendMessage(createUserMessage("accepted"));
		await env.appendStarted.promise;
		let closed = false;
		const dispose = store[Symbol.asyncDispose]().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		env.releaseAppend.resolve();
		await append;
		await dispose;
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow("JSONL session store is disposed");
	});

	it("parses once when opened and retains state across appends", async () => {
		const root = createTempDir();
		const env = new CountingReadEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const created = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await created.getMetadata();
		await created.appendMessage(createUserMessage("initial"));
		env.readCount = 0;
		const opened = await repo.open(metadata);
		for (let i = 0; i < 10; i++) await opened.appendMessage(createUserMessage(`message ${i}`));
		expect(env.readCount).toBe(1);
	});

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

	it("fails loudly when listing a malformed session file", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		writeFileSync(metadata.path, "not json\n");

		await expect(repo.list()).rejects.toMatchObject({ code: "invalid_session" });
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
