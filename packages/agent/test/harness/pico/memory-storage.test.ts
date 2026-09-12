import { TODO_CONTEXT } from "@draht/chord/context";
import { describe, expect, it, vi } from "vitest";
import {
	defineList,
	defineValue,
	InvalidHistoryPosition,
	type JsonValue,
	MemoryStorage,
	ReadAfterWrite,
	ScratchRetired,
	Session,
	SharedOutputRetired,
	type Task,
	type TaskCreate,
	type Transaction,
} from "../../../src/harness/pico/index.ts";

const ctx = TODO_CONTEXT;

function taskSpec(
	conversationId: number,
	extra: Partial<Pick<TaskCreate, "kind" | "output" | "background">> = {},
): TaskCreate {
	return {
		conversationId,
		kind: "test.task",
		input: { value: conversationId },
		after: [],
		owns: [],
		status: "pending",
		...extra,
	};
}

type LiveTask = Task & { readonly status: "pending" | "running"; readonly outcome?: never };

async function setTask(session: Session, id: number, update: (task: LiveTask) => Task): Promise<void> {
	await session.commit(async (tx) => {
		const task = await tx.getTask(id);
		if (task === undefined || task.status === "terminal") throw new Error(`Task ${id} is not live`);
		tx.setTask(update(task));
	}, ctx);
}

describe("Pico Session over MemoryStorage", () => {
	it("separates IDs from sequences and burns IDs from failed callbacks", async () => {
		const storage = new MemoryStorage();
		expect(await storage.commit([{ type: "conversation.create", conversation: { id: 10 } }], ctx)).toEqual([1]);
		const state = defineValue<string>({ type: "session" }, "test.state");
		expect(await storage.commit([{ type: "value.set", address: state, value: "set" }], ctx)).toEqual([2]);
		expect(await new Session(storage).commit((tx) => tx.createConversation({}), ctx)).toBe(11);

		const sessionStorage = new MemoryStorage();
		const commit = vi.spyOn(sessionStorage, "commit");
		const session = new Session(sessionStorage);
		await expect(
			session.commit((tx) => {
				tx.createConversation({});
				throw new Error("reject");
			}, ctx),
		).rejects.toThrow("reject");
		expect(commit).not.toHaveBeenCalled();
		expect(await sessionStorage.getConversations([1], ctx)).toEqual(new Map());
		expect(await session.commit((tx) => tx.createConversation({}), ctx)).toBe(2);
		expect(commit).toHaveBeenCalledTimes(1);
		await expect(commit.mock.results[0]!.value).resolves.toEqual([1]);
		await expect(
			session.commit(async (tx) => {
				tx.createConversation({});
				await tx.getConversation(1);
			}, ctx),
		).rejects.toBeInstanceOf(ReadAfterWrite);
		expect(await session.commit((tx) => tx.createConversation({}), ctx)).toBe(4);
		expect(
			await session.commit(async (tx) => {
				const read = tx.getConversation(1);
				expect(() => tx.createConversation({})).toThrow("Transaction writes must await reads");
				await read;
				return tx.createConversation({});
			}, ctx),
		).toBe(5);

		let leaked!: Transaction;
		await session.commit((tx) => {
			leaked = tx;
		}, ctx);
		expect(() => leaked.createConversation({})).toThrow("Transaction is closed");

		const concurrent = await Promise.all([
			session.commit(async (tx) => {
				await tx.getConversation(1);
				return tx.createConversation({});
			}, ctx),
			session.commit((tx) => tx.createConversation({}), ctx),
		]);
		expect(concurrent).toEqual([6, 7]);
		expect(commit).toHaveBeenCalledTimes(5);
	});

	it("leaves state and sequence unchanged when persistence rejects", async () => {
		const storage = new MemoryStorage();
		const commit = vi.spyOn(storage, "commit").mockRejectedValueOnce(new Error("persistence failed"));
		await expect(new Session(storage).commit((tx) => tx.createConversation({}), ctx)).rejects.toThrow(
			"persistence failed",
		);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(await storage.getConversations([1], ctx)).toEqual(new Map());
		commit.mockRestore();

		const state = defineValue<string>({ type: "session" }, "test.after-failure");
		expect(await storage.commit([{ type: "value.set", address: state, value: "stored" }], ctx)).toEqual([1]);
		expect(await storage.getValue(state, undefined, ctx)).toBe("stored");
		expect(storage.nextId()).toBe(2);
	});

	it("uses write sequences for historical state inside one atomic storage batch", async () => {
		const storage = new MemoryStorage();
		const conversation = storage.nextId();
		const entry = storage.nextId();
		const beforeElement = storage.nextId();
		const afterElement = storage.nextId();
		const value = defineValue<string>({ type: "conversation", conversationId: conversation }, "test.value", {
			rewind: true,
		});
		const list = defineList<string>({ type: "conversation", conversationId: conversation }, "test.list", {
			rewind: true,
		});

		expect(
			await storage.commit(
				[
					{ type: "conversation.create", conversation: { id: conversation } },
					{ type: "value.set", address: value, value: "before" },
					{ type: "list.append", address: list, element: { id: beforeElement, value: "before" } },
					{ type: "entry.append", entry: { id: entry, conversationId: conversation, kind: "test.entry" } },
					{ type: "value.set", address: value, value: "after" },
					{ type: "list.append", address: list, element: { id: afterElement, value: "after" } },
				],
				ctx,
			),
		).toEqual([1, 2, 3, 4, 5, 6]);
		expect(entry).toBe(2);
		expect(await storage.getValue(value, entry, ctx)).toBe("before");
		expect(await storage.getValue(value, undefined, ctx)).toBe("after");
		expect((await storage.readList(list, entry, ctx)).map((item) => item.value)).toEqual(["before"]);
		expect((await storage.readList(list, undefined, ctx)).map((item) => item.value)).toEqual(["before", "after"]);
	});

	it("pages conversations and fork-visible entries", async () => {
		const session = new Session(new MemoryStorage());
		const ids = await session.commit((tx) => {
			const root = tx.createConversation({});
			const first = tx.entry({ conversationId: root, kind: "test.first" });
			const head = tx.entry({ conversationId: root, kind: "test.head", head: first });
			const fork = tx.createConversation({ parent: { conversationId: root, at: first } });
			const forkEntry = tx.entry({ conversationId: fork, kind: "fork.entry" });
			const late = tx.entry({ conversationId: root, kind: "root.late" });
			const ownedFork = tx.createConversation({ parent: { conversationId: root, at: first }, owner: 99 });
			return { root, first, head, fork, forkEntry, late, ownedFork };
		}, ctx);
		expect(ids).toEqual({ root: 1, first: 2, head: 3, fork: 4, forkEntry: 5, late: 6, ownedFork: 7 });

		const conversations = await session.scanConversations({ limit: 1 }, ctx);
		expect(conversations.items.map(({ id }) => id)).toEqual([1]);
		expect(
			(await session.scanConversations({ cursor: conversations.next, limit: 1 }, ctx)).items.map(({ id }) => id),
		).toEqual([4]);
		expect((await session.getConversations([ids.ownedFork, 999_999], ctx)).has(ids.ownedFork)).toBe(true);
		expect((await session.scanConversations({ parent: ids.root, limit: 10 }, ctx)).items.map(({ id }) => id)).toEqual(
			[ids.fork, ids.ownedFork],
		);
		expect((await session.scanConversations({ owner: 99, limit: 10 }, ctx)).items.map(({ id }) => id)).toEqual([
			ids.ownedFork,
		]);
		expect(
			(await session.scanConversations({ parent: ids.root, owner: 99, limit: 10 }, ctx)).items.map(({ id }) => id),
		).toEqual([ids.ownedFork]);

		const fork = await session.scanEntries({ conversationId: 4, limit: 1 }, ctx);
		expect(fork.items.map(({ id }) => id)).toEqual([5]);
		expect(
			(await session.scanEntries({ conversationId: 4, cursor: fork.next, limit: 1 }, ctx)).items.map(({ id }) => id),
		).toEqual([2]);
		expect(
			(await session.scanEntries({ conversationId: 1, through: 3, limit: 10 }, ctx)).items.map(({ id }) => id),
		).toEqual([3, 2]);
		expect(
			(await session.scanEntries({ conversationId: ids.root, kind: "test.head", limit: 10 }, ctx)).items.map(
				({ id }) => id,
			),
		).toEqual([ids.head]);
		expect((await session.getEntries([ids.first, 999_999], ctx)).has(ids.first)).toBe(true);
		expect((await session.newestHead(1, 3, ctx))?.id).toBe(3);
		expect(await session.newestHead(4, 5, ctx)).toBeUndefined();
	});

	it("buffers values and list elements into one commit", async () => {
		const session = new Session(new MemoryStorage());
		const value = defineValue<JsonValue>({ type: "conversation", conversationId: 1 }, "test.value", {
			rewind: false,
		});
		const list = defineList<string>({ type: "conversation", conversationId: 1 }, "test.list", { rewind: false });
		const ids = await session.commit((tx) => {
			const conversation = tx.createConversation({});
			tx.value(value).set({ version: 1 });
			const first = tx.list(list).append("a");
			const second = tx.list(list).append("b");
			return { conversation, first, second };
		}, ctx);
		expect(ids).toEqual({ conversation: 1, first: 2, second: 3 });
		expect(await session.getValue(value, undefined, ctx)).toEqual({ version: 1 });

		expect((await session.readList(list, undefined, ctx)).map(({ value }) => value)).toEqual(["a", "b"]);

		await session.commit((tx) => {
			tx.value(value).delete();
			tx.list(list).remove(ids.first);
			tx.list(list).clear();
		}, ctx);
		expect(await session.getValue(value, undefined, ctx)).toBeUndefined();
		expect(await session.readList(list, undefined, ctx)).toEqual([]);
	});

	it("rewinds values through fork caps and preserves local tombstones", async () => {
		const storage = new MemoryStorage();
		const session = new Session(storage);
		const root = await session.commit((tx) => tx.createConversation({}), ctx);
		const rootValue = defineValue<string>({ type: "conversation", conversationId: root }, "test.history", {
			rewind: true,
		});
		const first = await session.commit((tx) => {
			tx.value(rootValue).set("root-first");
			return tx.entry({ conversationId: root, kind: "root.first" });
		}, ctx);
		const deleted = await session.commit((tx) => {
			tx.value(rootValue).delete();
			return tx.entry({ conversationId: root, kind: "root.deleted" });
		}, ctx);
		const late = await session.commit((tx) => {
			tx.value(rootValue).set("root-late");
			return tx.entry({ conversationId: root, kind: "root.late" });
		}, ctx);

		expect(await session.getValue(rootValue, undefined, ctx)).toBe("root-late");
		expect(await session.getValue(rootValue, first, ctx)).toBe("root-first");
		expect(await session.getValue(rootValue, deleted, ctx)).toBeUndefined();
		expect(await session.getValue(rootValue, late, ctx)).toBe("root-late");

		const child = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: root, at: first } }),
			ctx,
		);
		const childValue = defineValue<string>({ type: "conversation", conversationId: child }, "test.history", {
			rewind: true,
		});
		expect(await session.getValue(childValue, undefined, ctx)).toBe("root-first");
		const childDeleted = await session.commit((tx) => {
			tx.value(childValue).delete();
			return tx.entry({ conversationId: child, kind: "child.deleted" });
		}, ctx);
		const grandchild = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: child, at: childDeleted } }),
			ctx,
		);
		const grandchildValue = defineValue<string>(
			{ type: "conversation", conversationId: grandchild },
			"test.history",
			{ rewind: true },
		);
		await session.commit((tx) => {
			tx.value(childValue).set("child-late");
			tx.entry({ conversationId: child, kind: "child.late" });
		}, ctx);

		expect(await session.getValue(childValue, undefined, ctx)).toBe("child-late");
		expect(await session.getValue(grandchildValue, undefined, ctx)).toBeUndefined();
		expect(await session.getValue(grandchildValue, first, ctx)).toBe("root-first");
		expect(await session.getValue(grandchildValue, childDeleted, ctx)).toBeUndefined();

		const sibling = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: root, at: first } }),
			ctx,
		);
		const siblingValue = defineValue<string>({ type: "conversation", conversationId: sibling }, "test.history", {
			rewind: true,
		});
		expect(await session.getValue(siblingValue, undefined, ctx)).toBe("root-first");
		await session.commit((tx) => tx.value(siblingValue).set("sibling"), ctx);
		expect(await session.getValue(siblingValue, undefined, ctx)).toBe("sibling");
		expect(await session.getValue(childValue, undefined, ctx)).toBe("child-late");
		expect(await session.getValue(grandchildValue, undefined, ctx)).toBeUndefined();

		const deepAncestorFork = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: grandchild, at: first } }),
			ctx,
		);
		const deepAncestorValue = defineValue<string>(
			{ type: "conversation", conversationId: deepAncestorFork },
			"test.history",
			{ rewind: true },
		);
		expect(await session.getValue(deepAncestorValue, undefined, ctx)).toBe("root-first");
		await expect(session.getValue(childValue, deleted, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(session.getValue(childValue, 999_999, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);

		const unrelated = await session.commit((tx) => {
			const conversation = tx.createConversation({});
			return tx.entry({ conversationId: conversation, kind: "unrelated" });
		}, ctx);
		await expect(session.getValue(childValue, unrelated, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);

		const sticky = defineValue<string>({ type: "conversation", conversationId: root }, "test.sticky", {
			rewind: false,
		});
		const sessionValue = defineValue<string>({ type: "session" }, "test.history");
		const taskList = defineList<string>({ type: "task", taskId: 100 }, "test.history");
		const sharedValue = defineValue<string>({ type: "shared", id: 200 }, "test.history");
		await expect(storage.getValue(sticky, first, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(storage.getValue(sessionValue, first, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(storage.readList(taskList, first, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(storage.getValue(sharedValue, first, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
	});

	it("rewinds complete lists through append, remove, clear, and nested fork caps", async () => {
		const session = new Session(new MemoryStorage());
		const root = await session.commit((tx) => tx.createConversation({}), ctx);
		const rootList = defineList<string>({ type: "conversation", conversationId: root }, "test.history-list", {
			rewind: true,
		});
		const first = await session.commit((tx) => {
			const a = tx.list(rootList).append("a");
			const b = tx.list(rootList).append("b");
			const entry = tx.entry({ conversationId: root, kind: "root.first" });
			return { a, b, entry };
		}, ctx);
		const second = await session.commit((tx) => {
			tx.list(rootList).remove(first.a);
			const c = tx.list(rootList).append("c");
			const entry = tx.entry({ conversationId: root, kind: "root.second" });
			return { c, entry };
		}, ctx);
		const third = await session.commit((tx) => {
			tx.list(rootList).clear();
			const d = tx.list(rootList).append("d");
			const entry = tx.entry({ conversationId: root, kind: "root.third" });
			return { d, entry };
		}, ctx);
		await session.commit((tx) => tx.list(rootList).append("e"), ctx);

		expect((await session.readList(rootList, first.entry, ctx)).map((item) => item.value)).toEqual(["a", "b"]);
		expect((await session.readList(rootList, second.entry, ctx)).map((item) => item.value)).toEqual(["b", "c"]);
		expect((await session.readList(rootList, third.entry, ctx)).map((item) => item.value)).toEqual(["d"]);
		expect((await session.readList(rootList, undefined, ctx)).map((item) => item.value)).toEqual(["d", "e"]);

		const child = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: root, at: second.entry } }),
			ctx,
		);
		const childList = defineList<string>({ type: "conversation", conversationId: child }, "test.history-list", {
			rewind: true,
		});
		const childAppend = await session.commit((tx) => {
			tx.list(childList).append("x");
			return tx.entry({ conversationId: child, kind: "child.append" });
		}, ctx);
		const childRemove = await session.commit((tx) => {
			tx.list(childList).remove(first.b);
			return tx.entry({ conversationId: child, kind: "child.remove" });
		}, ctx);
		const grandchild = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: child, at: childRemove } }),
			ctx,
		);
		const grandchildList = defineList<string>(
			{ type: "conversation", conversationId: grandchild },
			"test.history-list",
			{ rewind: true },
		);
		const childClear = await session.commit((tx) => {
			tx.list(childList).clear();
			tx.list(childList).append("y");
			return tx.entry({ conversationId: child, kind: "child.clear" });
		}, ctx);
		await session.commit((tx) => {
			tx.list(grandchildList).append("z");
			tx.entry({ conversationId: grandchild, kind: "grandchild.append" });
		}, ctx);

		expect((await session.readList(childList, childAppend, ctx)).map((item) => item.value)).toEqual(["b", "c", "x"]);
		expect((await session.readList(childList, childRemove, ctx)).map((item) => item.value)).toEqual(["c", "x"]);
		expect((await session.readList(childList, childClear, ctx)).map((item) => item.value)).toEqual(["y"]);
		expect((await session.readList(childList, undefined, ctx)).map((item) => item.value)).toEqual(["y"]);
		expect((await session.readList(grandchildList, undefined, ctx)).map((item) => item.value)).toEqual([
			"c",
			"x",
			"z",
		]);
		expect((await session.readList(grandchildList, childRemove, ctx)).map((item) => item.value)).toEqual(["c", "x"]);

		const sibling = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: root, at: second.entry } }),
			ctx,
		);
		const siblingList = defineList<string>({ type: "conversation", conversationId: sibling }, "test.history-list", {
			rewind: true,
		});
		expect((await session.readList(siblingList, undefined, ctx)).map((item) => item.value)).toEqual(["b", "c"]);
		await session.commit((tx) => tx.list(siblingList).append("s"), ctx);
		expect((await session.readList(siblingList, undefined, ctx)).map((item) => item.value)).toEqual(["b", "c", "s"]);
		expect((await session.readList(childList, undefined, ctx)).map((item) => item.value)).toEqual(["y"]);

		const deepAncestorFork = await session.commit(
			(tx) => tx.createConversation({ parent: { conversationId: grandchild, at: second.entry } }),
			ctx,
		);
		const deepAncestorList = defineList<string>(
			{ type: "conversation", conversationId: deepAncestorFork },
			"test.history-list",
			{ rewind: true },
		);
		expect((await session.readList(deepAncestorList, undefined, ctx)).map((item) => item.value)).toEqual(["b", "c"]);

		const unrelated = await session.commit((tx) => {
			const conversation = tx.createConversation({});
			return tx.entry({ conversationId: conversation, kind: "unrelated" });
		}, ctx);
		const stickyList = defineList<string>({ type: "conversation", conversationId: child }, "test.sticky", {
			rewind: false,
		});
		await expect(session.readList(childList, third.entry, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(session.readList(childList, unrelated, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(session.readList(childList, 999_999, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
		await expect(session.readList(stickyList, childRemove, ctx)).rejects.toBeInstanceOf(InvalidHistoryPosition);
	});

	it("keeps scopes, kinds, optional keys, and rewind stores separate", async () => {
		const session = new Session(new MemoryStorage());
		const conversation = await session.commit((tx) => tx.createConversation({}), ctx);
		const scope = { type: "conversation", conversationId: conversation } as const;
		const stickyValue = defineValue<string>(scope, "test.identity", { key: "same", rewind: false });
		const rewindValue = defineValue<string>(scope, "test.identity", { key: "same", rewind: true });
		const stickyList = defineList<string>(scope, "test.identity", { key: "same", rewind: false });
		const rewindList = defineList<string>(scope, "test.identity", { key: "same", rewind: true });
		const absentKey = defineValue<string>(scope, "test.optional-key", { rewind: false });
		const undefinedKey = defineValue<string>(scope, "test.optional-key", { key: undefined, rewind: false });
		const emptyKey = defineValue<string>(scope, "test.optional-key", { key: "", rewind: false });
		const sessionValue = defineValue<string>({ type: "session" }, "test.identity", { key: "same" });

		await session.commit((tx) => {
			tx.value(stickyValue).set("sticky-value");
			tx.value(rewindValue).set("rewind-value");
			tx.list(stickyList).append("sticky-list");
			tx.list(rewindList).append("rewind-list");
			tx.value(absentKey).set("absent");
			tx.value(emptyKey).set("empty");
			tx.value(sessionValue).set("session");
		}, ctx);

		expect(await session.getValue(stickyValue, undefined, ctx)).toBe("sticky-value");
		expect(await session.getValue(rewindValue, undefined, ctx)).toBe("rewind-value");
		expect((await session.readList(stickyList, undefined, ctx)).map((item) => item.value)).toEqual(["sticky-list"]);
		expect((await session.readList(rewindList, undefined, ctx)).map((item) => item.value)).toEqual(["rewind-list"]);
		expect(await session.getValue(absentKey, undefined, ctx)).toBe("absent");
		expect(await session.getValue(undefinedKey, undefined, ctx)).toBe("absent");
		expect(await session.getValue(emptyKey, undefined, ctx)).toBe("empty");
		expect(await session.getValue(sessionValue, undefined, ctx)).toBe("session");
	});

	it("stores task snapshots and retires scratch and shared output", async () => {
		const storage = new MemoryStorage();
		const session = new Session(storage);
		const ids = await session.commit((tx) => {
			const conversation = tx.createConversation({});
			const producer = tx.task(taskSpec(conversation, { output: { kind: "test.output" } }));
			const output = defineList<JsonValue>({ type: "shared", id: producer }, "pi.output");
			tx.list(output).append([["r", { text: "" }]]);
			const consumer = tx.task(taskSpec(conversation, { output: { id: producer, kind: "test.output" } }));
			return { conversation, producer, consumer };
		}, ctx);
		expect(ids).toEqual({ conversation: 1, producer: 2, consumer: 4 });

		const output = defineList<JsonValue>({ type: "shared", id: ids.producer }, "pi.output");
		const scratch = defineValue<JsonValue>({ type: "task", taskId: ids.producer }, "test.scratch");
		await session.commit((tx) => {
			tx.value(scratch).set({ n: 1 });
			tx.list(output).append([["s", ["text"], "done"]]);
			tx.list(output).append([["s", ["status"], "complete"]]);
		}, ctx);

		await setTask(session, ids.producer, (task) => ({ ...task, status: "running" }));
		await setTask(session, ids.producer, (task) => ({ ...task, checkpoint: { phase: "working" } }));
		await setTask(session, ids.producer, (task) => ({
			...task,
			status: "terminal",
			outcome: { status: "completed", result: null },
		}));
		await expect(session.getValue(scratch, undefined, ctx)).rejects.toBeInstanceOf(ScratchRetired);
		expect(await storage.getValue(scratch, undefined, ctx)).toBeUndefined();

		await setTask(session, ids.consumer, (task) => ({ ...task, status: "running" }));
		const replacement = await session.commit(async (tx) => {
			const consumer = await tx.getTask(ids.consumer);
			if (consumer === undefined || consumer.status === "terminal") throw new Error("Consumer is not live");
			tx.setTask({ ...consumer, status: "terminal", outcome: { status: "completed", result: null } });
			return tx.task(taskSpec(ids.conversation, { output: { id: ids.producer, kind: "test.output" } }));
		}, ctx);
		expect(await session.readList(output, undefined, ctx)).toHaveLength(3);
		await setTask(session, replacement, (task) => ({ ...task, status: "running" }));
		await setTask(session, replacement, (task) => ({
			...task,
			status: "terminal",
			outcome: { status: "completed", result: null },
		}));
		await expect(session.readList(output, undefined, ctx)).rejects.toBeInstanceOf(SharedOutputRetired);
		expect(await storage.readList(output, undefined, ctx)).toEqual([]);
	});

	it("filters and pages tasks", async () => {
		const session = new Session(new MemoryStorage());
		const ids = await session.commit((tx) => {
			const conversation = tx.createConversation({});
			const otherConversation = tx.createConversation({});
			return {
				conversation,
				otherConversation,
				first: tx.task(taskSpec(conversation)),
				second: tx.task(
					taskSpec(conversation, { kind: "other", background: true, output: { kind: "test.output" } }),
				),
				third: tx.task(taskSpec(otherConversation)),
			};
		}, ctx);
		await setTask(session, ids.first, (task) => ({ ...task, abort: true }));
		await setTask(session, ids.first, (task) => ({ ...task, status: "running" }));
		await setTask(session, ids.first, (task) => ({
			...task,
			status: "terminal",
			outcome: { status: "aborted", result: null },
		}));

		const first = await session.scanTasks({ limit: 1 }, ctx);
		expect(first.items.map(({ id }) => id)).toEqual([ids.first]);
		expect((await session.scanTasks({ cursor: first.next, limit: 1 }, ctx)).items.map(({ id }) => id)).toEqual([
			ids.second,
		]);
		expect((await session.getTasks([ids.first, 999_999], ctx)).has(ids.first)).toBe(true);
		expect(
			(await session.scanTasks({ conversationIds: [ids.conversation], limit: 10 }, ctx)).items.map(({ id }) => id),
		).toEqual([ids.first, ids.second]);
		expect((await session.scanTasks({ kind: "other", limit: 10 }, ctx)).items.map(({ id }) => id)).toEqual([
			ids.second,
		]);
		expect((await session.scanTasks({ outputId: ids.second, limit: 10 }, ctx)).items.map(({ id }) => id)).toEqual([
			ids.second,
		]);
		expect(
			(
				await session.scanTasks(
					{
						conversationIds: [ids.conversation],
						statuses: ["terminal"],
						kind: "test.task",
						abort: true,
						limit: 10,
					},
					ctx,
				)
			).items.map(({ id }) => id),
		).toEqual([ids.first]);
	});
});
