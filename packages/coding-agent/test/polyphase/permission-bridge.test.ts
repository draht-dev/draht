import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	type ChildChannel,
	claimParentPermissionBridge,
	createParentPermissionBridge,
	type ParentChannel,
	type PermissionAnswerMessage,
	type PermissionAskMessage,
	type PermissionWithdrawMessage,
	POLYPHASE_PERMISSION_BRIDGE_ENV,
	parseAnswerMessage,
	parseAskMessage,
	serveChildPermissionAsks,
	toChildPermissionInput,
} from "../../src/core/polyphase/permission-bridge.ts";
import type { ChildPermissionRequest, ChildPermissionVerdict } from "../../src/core/polyphase/types.ts";

/** The child's end of a fake IPC channel, wired straight to `parentHandler`. */
class FakeParentChannel implements ParentChannel {
	connected = true;
	readonly sent: (PermissionAskMessage | PermissionWithdrawMessage)[] = [];
	subscriptions = 0;
	private onMessage?: (message: unknown) => void;
	private onDisconnect?: () => void;
	sendError: Error | null = null;

	isConnected(): boolean {
		return this.connected;
	}

	send(message: PermissionAskMessage | PermissionWithdrawMessage, callback: (error: Error | null) => void): void {
		this.sent.push(message);
		const error = this.sendError;
		queueMicrotask(() => callback(error));
	}

	subscribe(onMessage: (message: unknown) => void, onDisconnect: () => void): () => void {
		this.subscriptions++;
		this.onMessage = onMessage;
		this.onDisconnect = onDisconnect;
		return () => {
			this.subscriptions--;
			this.onMessage = undefined;
			this.onDisconnect = undefined;
		};
	}

	deliver(message: unknown): void {
		this.onMessage?.(message);
	}

	disconnect(): void {
		this.connected = false;
		this.onDisconnect?.();
	}

	lastAsk(): PermissionAskMessage {
		const ask = [...this.sent].reverse().find((m): m is PermissionAskMessage => m.type === "draht.permission.ask");
		if (!ask) throw new Error("no ask was sent");
		return ask;
	}
}

const sampleAsk = { toolName: "bash", toolCallId: "call-1", input: { command: "npm test" }, via: [] };

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("createParentPermissionBridge", () => {
	it("sends one ask and resolves with the parent's answer", async () => {
		const channel = new FakeParentChannel();
		const bridge = createParentPermissionBridge(channel);
		const pending = bridge.ask(sampleAsk);
		const ask = channel.lastAsk();
		expect(ask).toMatchObject({ toolName: "bash", toolCallId: "call-1", input: { command: "npm test" }, via: [] });

		channel.deliver({ type: "draht.permission.answer", id: ask.id, verdict: "approved" });
		await expect(pending).resolves.toEqual({ kind: "approved" });
	});

	it("carries a denial's reason, and supplies one when the parent sent none", async () => {
		const channel = new FakeParentChannel();
		const bridge = createParentPermissionBridge(channel);

		const first = bridge.ask(sampleAsk);
		channel.deliver({ type: "draht.permission.answer", id: channel.lastAsk().id, verdict: "denied", reason: "no" });
		await expect(first).resolves.toEqual({ kind: "denied", reason: "no" });

		const second = bridge.ask(sampleAsk);
		channel.deliver({ type: "draht.permission.answer", id: channel.lastAsk().id, verdict: "denied" });
		await expect(second).resolves.toEqual({ kind: "denied", reason: "Denied in the parent session" });
	});

	it("ignores answers for unknown ids and malformed answers", async () => {
		const channel = new FakeParentChannel();
		const bridge = createParentPermissionBridge(channel);
		let settled = false;
		const pending = bridge.ask(sampleAsk).then((verdict) => {
			settled = true;
			return verdict;
		});
		const id = channel.lastAsk().id;

		channel.deliver({ type: "draht.permission.answer", id: "someone-else", verdict: "approved" });
		channel.deliver({ type: "draht.permission.answer", id, verdict: "maybe" });
		channel.deliver({ type: "something.else", id, verdict: "approved" });
		await flush();
		expect(settled).toBe(false);

		channel.deliver({ type: "draht.permission.answer", id, verdict: "approved" });
		await expect(pending).resolves.toEqual({ kind: "approved" });
	});

	it("is unavailable when the channel is closed, fails to send, or disconnects while waiting", async () => {
		const closed = new FakeParentChannel();
		closed.connected = false;
		await expect(createParentPermissionBridge(closed).ask(sampleAsk)).resolves.toEqual({ kind: "unavailable" });
		expect(closed.sent).toHaveLength(0);

		const failing = new FakeParentChannel();
		failing.sendError = new Error("EPIPE");
		await expect(createParentPermissionBridge(failing).ask(sampleAsk)).resolves.toEqual({ kind: "unavailable" });

		const dropping = new FakeParentChannel();
		const pending = createParentPermissionBridge(dropping).ask(sampleAsk);
		dropping.disconnect();
		await expect(pending).resolves.toEqual({ kind: "unavailable" });
	});

	it("withdraws the ask and resolves cancelled when the turn is aborted", async () => {
		const channel = new FakeParentChannel();
		const bridge = createParentPermissionBridge(channel);
		const controller = new AbortController();
		const pending = bridge.ask(sampleAsk, controller.signal);
		const id = channel.lastAsk().id;

		controller.abort();
		await expect(pending).resolves.toEqual({ kind: "cancelled" });
		expect(channel.sent.at(-1)).toEqual({ type: "draht.permission.withdraw", id });

		// A late answer for the withdrawn ask changes nothing.
		channel.deliver({ type: "draht.permission.answer", id, verdict: "approved" });
		await expect(pending).resolves.toEqual({ kind: "cancelled" });
	});

	it("does not ask at all for an already-aborted turn", async () => {
		const channel = new FakeParentChannel();
		const controller = new AbortController();
		controller.abort();
		await expect(createParentPermissionBridge(channel).ask(sampleAsk, controller.signal)).resolves.toEqual({
			kind: "cancelled",
		});
		expect(channel.sent).toHaveLength(0);
	});

	it("listens only while an ask is waiting, so an idle child can exit", async () => {
		const channel = new FakeParentChannel();
		const bridge = createParentPermissionBridge(channel);
		expect(channel.subscriptions).toBe(0);

		const first = bridge.ask(sampleAsk);
		const firstId = channel.lastAsk().id;
		const second = bridge.ask(sampleAsk);
		const secondId = channel.lastAsk().id;
		expect(channel.subscriptions).toBe(1);

		channel.deliver({ type: "draht.permission.answer", id: firstId, verdict: "approved" });
		await first;
		expect(channel.subscriptions).toBe(1);

		channel.deliver({ type: "draht.permission.answer", id: secondId, verdict: "approved" });
		await second;
		expect(channel.subscriptions).toBe(0);
	});
});

describe("claimParentPermissionBridge", () => {
	it("consumes the marker so nothing this process spawns inherits it", () => {
		vi.stubEnv(POLYPHASE_PERMISSION_BRIDGE_ENV, "1");
		claimParentPermissionBridge();
		expect(process.env[POLYPHASE_PERMISSION_BRIDGE_ENV]).toBeUndefined();
		vi.unstubAllEnvs();
	});
});

describe("toChildPermissionInput", () => {
	it("keeps the gate's own keys verbatim, however long", () => {
		const command = `npm test ${"x".repeat(10_000)}; rm -rf /`;
		const input = toChildPermissionInput({ command, path: "src/a.ts", file_path: "/abs/b.ts" });
		expect(input).toEqual({ command, path: "src/a.ts", file_path: "/abs/b.ts" });
	});

	it("never hands the parent's gate a non-string gate value, but still shows it", () => {
		expect(toChildPermissionInput({ path: ["src/x"], command: 42 })).toEqual({
			"path (not a string)": '["src/x"]',
			"command (not a string)": "42",
		});
	});

	it("never drops a gate key behind junk keys, however many come first", () => {
		const junk = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), 0]));
		const input = toChildPermissionInput({ ...junk, pattern: ".", path: "/home/u/.ssh/id_ed25519" });

		expect(input.path).toBe("/home/u/.ssh/id_ed25519");
		expect(Object.keys(input)).toHaveLength(64);
		// 64 junk keys and `pattern` compete for the 63 slots `path` leaves: 62 shown, 3 summarized.
		expect(input["(more arguments)"]).toBe("3 more not shown");
		// And the parent accepts what the child sends.
		const parsed = parseAskMessage({
			type: "draht.permission.ask",
			id: "a",
			toolName: "grep",
			toolCallId: "c",
			input,
			via: [],
		});
		expect(parsed?.ok).toBe(true);
	});

	it("bounds display-only values and serializes structured ones", () => {
		const input = toChildPermissionInput({ content: "y".repeat(5000), limit: 10, deep: { a: [1, 2] }, flag: true });
		expect(typeof input.content).toBe("string");
		expect((input.content as string).length).toBeLessThanOrEqual(2049);
		expect(input).toMatchObject({ limit: 10, deep: '{"a":[1,2]}', flag: true });
	});

	it("keeps `__proto__` an ordinary key", () => {
		const raw = JSON.parse('{"__proto__": "x", "command": "ls"}') as Record<string, unknown>;
		const input = toChildPermissionInput(raw);
		expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
		expect(Object.keys(input).sort()).toEqual(["__proto__", "command"]);
	});
});

describe("parseAskMessage / parseAnswerMessage", () => {
	const valid = {
		type: "draht.permission.ask",
		id: "a1",
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "ls" },
		via: ["helper#1"],
	};

	it("accepts a well-formed ask", () => {
		expect(parseAskMessage(valid)).toEqual({ ok: true, message: valid });
	});

	it("returns undefined for messages that are not asks, or have no usable id", () => {
		expect(parseAskMessage({ ...valid, type: "other" })).toBeUndefined();
		expect(parseAskMessage({ ...valid, id: "" })).toBeUndefined();
		expect(parseAskMessage({ ...valid, id: "x".repeat(200) })).toBeUndefined();
		expect(parseAskMessage("draht.permission.ask")).toBeUndefined();
	});

	it("flags an ask with a usable id but an unusable body, so it can still be answered", () => {
		expect(parseAskMessage({ ...valid, input: { command: { nested: true } } })).toEqual({ ok: false, id: "a1" });
		expect(parseAskMessage({ ...valid, input: { command: "x".repeat(300 * 1024) } })).toEqual({
			ok: false,
			id: "a1",
		});
		expect(parseAskMessage({ ...valid, via: [1] })).toEqual({ ok: false, id: "a1" });
		expect(parseAskMessage({ ...valid, toolName: "" })).toEqual({ ok: false, id: "a1" });
	});

	it("rejects unknown verdicts", () => {
		expect(parseAnswerMessage({ type: "draht.permission.answer", id: "a1", verdict: "yes" })).toBeUndefined();
		expect(parseAnswerMessage({ type: "draht.permission.answer", id: "a1", verdict: "cancelled" })).toEqual({
			id: "a1",
			verdict: { kind: "cancelled" },
		});
	});
});

/** The parent's end of a fake IPC channel. */
class FakeChildChannel extends EventEmitter implements ChildChannel {
	connected = true;
	readonly answers: PermissionAnswerMessage[] = [];

	send(message: PermissionAnswerMessage, callback: (error: Error | null) => void): boolean {
		this.answers.push(message);
		callback(null);
		return true;
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("serveChildPermissionAsks", () => {
	it("hands a valid ask to the asker with the parent's own cwd, and answers the child", async () => {
		const child = new FakeChildChannel();
		const seen: ChildPermissionRequest[] = [];
		const server = serveChildPermissionAsks(
			child,
			async (request) => {
				seen.push(request);
				return { kind: "approved" };
			},
			{ cwd: "/parent/knows/this" },
		);

		child.emit("message", {
			type: "draht.permission.ask",
			id: "a1",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "ls" },
			via: [],
			cwd: "/child/claims/this",
		});
		await flush();

		expect(seen).toEqual([
			{ toolName: "bash", toolCallId: "c1", input: { command: "ls" }, via: [], cwd: "/parent/knows/this" },
		]);
		expect(child.answers).toEqual([{ type: "draht.permission.answer", id: "a1", verdict: "approved" }]);
		server.dispose();
	});

	it("answers unavailable for an ask whose body is unusable, and when the asker throws", async () => {
		const child = new FakeChildChannel();
		const server = serveChildPermissionAsks(
			child,
			async () => {
				throw new Error("boom");
			},
			{ cwd: "/p" },
		);

		child.emit("message", {
			type: "draht.permission.ask",
			id: "bad",
			toolName: "bash",
			toolCallId: "c",
			input: 5,
			via: [],
		});
		child.emit("message", {
			type: "draht.permission.ask",
			id: "t",
			toolName: "bash",
			toolCallId: "c",
			input: {},
			via: [],
		});
		await flush();

		expect(child.answers).toEqual([
			{ type: "draht.permission.answer", id: "bad", verdict: "unavailable" },
			{ type: "draht.permission.answer", id: "t", verdict: "unavailable" },
		]);
		server.dispose();
	});

	it("aborts the asker's signal when the child withdraws, and when the server is disposed", async () => {
		const child = new FakeChildChannel();
		const signals: AbortSignal[] = [];
		const gates: { resolve: (value: ChildPermissionVerdict) => void }[] = [];
		const server = serveChildPermissionAsks(
			child,
			(_request, signal) => {
				signals.push(signal);
				const gate = deferred<ChildPermissionVerdict>();
				gates.push(gate);
				return gate.promise;
			},
			{ cwd: "/p" },
		);
		const ask = (id: string) => ({
			type: "draht.permission.ask",
			id,
			toolName: "bash",
			toolCallId: id,
			input: {},
			via: [],
		});

		child.emit("message", ask("w"));
		child.emit("message", ask("d"));
		await flush();
		expect(signals).toHaveLength(2);

		child.emit("message", { type: "draht.permission.withdraw", id: "w" });
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);

		server.dispose();
		expect(signals[1]?.aborted).toBe(true);

		// Nothing is sent after dispose, whatever the asker eventually returns.
		for (const gate of gates) gate.resolve({ kind: "approved" });
		await flush();
		expect(child.answers).toEqual([]);
	});

	it("aborts every pending ask when the run's own signal aborts", async () => {
		const child = new FakeChildChannel();
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const server = serveChildPermissionAsks(
			child,
			(_request, signal) => {
				seen = signal;
				return new Promise<ChildPermissionVerdict>(() => {});
			},
			{ cwd: "/p", signal: controller.signal },
		);
		child.emit("message", {
			type: "draht.permission.ask",
			id: "x",
			toolName: "bash",
			toolCallId: "c",
			input: {},
			via: [],
		});
		await flush();

		controller.abort();
		expect(seen?.aborted).toBe(true);
		server.dispose();
	});
});
