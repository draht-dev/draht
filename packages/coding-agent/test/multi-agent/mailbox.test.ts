import { describe, expect, it } from "vitest";
import { MailboxSystem, type Message } from "../../src/core/multi-agent/mailbox.ts";

describe("MailboxSystem", () => {
	it("registers two agents", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");
		expect(system.isRegistered("agent-a")).toBe(true);
		expect(system.isRegistered("agent-b")).toBe(true);
	});

	it("sends a message from agent-a to agent-b and agent-b receives it", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");

		const result = system.send("agent-a", "agent-b", { type: "TaskRequest", payload: { task: "do-thing" } });
		expect(result.ok).toBe(true);

		const inbox = system.drain("agent-b");
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toMatchObject({
			from: "agent-a",
			to: "agent-b",
			type: "TaskRequest",
			payload: { task: "do-thing" },
		});

		// agent-a's own mailbox is untouched
		expect(system.drain("agent-a")).toHaveLength(0);
	});

	it("broadcast reaches all agents except the sender", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");
		system.register("agent-c");

		system.broadcast("agent-a", { type: "Abort", payload: { reason: "stop-everything" } });

		expect(system.drain("agent-a")).toHaveLength(0);
		const bInbox = system.drain("agent-b");
		const cInbox = system.drain("agent-c");
		expect(bInbox).toHaveLength(1);
		expect(cInbox).toHaveLength(1);
		expect(bInbox[0].type).toBe("Abort");
		expect(cInbox[0].type).toBe("Abort");
	});

	it("destroys the mailbox on agent deregister", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");

		system.deregister("agent-b");
		expect(system.isRegistered("agent-b")).toBe(false);

		const result = system.send("agent-a", "agent-b", { type: "DataExchange", payload: {} });
		expect(result.ok).toBe(false);
	});

	it("returns an error (not a throw) when sending to a non-existent mailbox", () => {
		const system = new MailboxSystem();
		system.register("agent-a");

		let thrown = false;
		let result: { ok: boolean; error?: string } | undefined;
		try {
			result = system.send("agent-a", "agent-ghost", { type: "TaskRequest" });
		} catch {
			thrown = true;
		}

		expect(thrown).toBe(false);
		expect(result?.ok).toBe(false);
		expect(result?.error).toBeTruthy();
	});

	it("orders messages FIFO", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");

		system.send("agent-a", "agent-b", { type: "DataExchange", payload: { seq: 1 } });
		system.send("agent-a", "agent-b", { type: "DataExchange", payload: { seq: 2 } });
		system.send("agent-a", "agent-b", { type: "DataExchange", payload: { seq: 3 } });

		const inbox = system.drain("agent-b");
		expect(inbox.map((m) => (m.payload as { seq: number }).seq)).toEqual([1, 2, 3]);
	});

	it("drain() returns all pending messages and clears the queue", () => {
		const system = new MailboxSystem();
		system.register("agent-a");
		system.register("agent-b");

		system.send("agent-a", "agent-b", { type: "TaskResult", payload: { ok: true } });
		system.send("agent-a", "agent-b", { type: "TaskResult", payload: { ok: false } });

		const first: Message[] = system.drain("agent-b");
		expect(first).toHaveLength(2);

		const second = system.drain("agent-b");
		expect(second).toHaveLength(0);
	});
});
