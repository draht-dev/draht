import { describe, expect, it } from "vitest";
import { AgentFSM, type AgentState } from "../../src/core/multi-agent/fsm.ts";

describe("AgentFSM", () => {
	it("starts in IDLE state", () => {
		const fsm = new AgentFSM("agent-1");
		expect(fsm.state).toBe("IDLE");
		expect(fsm.agentId).toBe("agent-1");
	});

	it("allows the full request/response cycle: IDLE -> REQUEST -> WORKING -> RESPOND -> IDLE", () => {
		const fsm = new AgentFSM("agent-1");

		fsm.transition("REQUEST");
		expect(fsm.state).toBe("REQUEST");

		fsm.transition("WORKING");
		expect(fsm.state).toBe("WORKING");

		fsm.transition("RESPOND");
		expect(fsm.state).toBe("RESPOND");

		fsm.transition("IDLE");
		expect(fsm.state).toBe("IDLE");
	});

	it("allows blocking and unblocking while working: WORKING -> WAIT -> WORKING", () => {
		const fsm = new AgentFSM("agent-1");
		fsm.transition("REQUEST");
		fsm.transition("WORKING");

		fsm.transition("WAIT");
		expect(fsm.state).toBe("WAIT");

		fsm.transition("WORKING");
		expect(fsm.state).toBe("WORKING");
	});

	it("throws on invalid transitions from IDLE", () => {
		const toWorking = new AgentFSM("agent-1");
		expect(() => toWorking.transition("WORKING")).toThrow();

		const toRespond = new AgentFSM("agent-2");
		expect(() => toRespond.transition("RESPOND")).toThrow();
	});

	it("leaves state unchanged when a transition is rejected", () => {
		const fsm = new AgentFSM("agent-1");
		expect(() => fsm.transition("WAIT")).toThrow();
		expect(fsm.state).toBe("IDLE");
	});

	it("emits transition events with { from, to, agentId, timestamp }", () => {
		const fsm = new AgentFSM("agent-42");
		const events: Array<{ from: AgentState; to: AgentState; agentId: string; timestamp: number }> = [];

		const unsubscribe = fsm.onTransition((event) => {
			events.push(event);
		});

		fsm.transition("REQUEST");

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ from: "IDLE", to: "REQUEST", agentId: "agent-42" });
		expect(typeof events[0]?.timestamp).toBe("number");

		unsubscribe();
		fsm.transition("WORKING");
		expect(events).toHaveLength(1);
	});

	it("serializes and deserializes for crash recovery", () => {
		const fsm = new AgentFSM("agent-7");
		fsm.transition("REQUEST");
		fsm.transition("WORKING");

		const serialized = fsm.serialize();
		expect(typeof serialized).toBe("string");

		const restored = AgentFSM.deserialize(serialized);
		expect(restored).toBeInstanceOf(AgentFSM);
		expect(restored.agentId).toBe("agent-7");
		expect(restored.state).toBe("WORKING");

		// Restored FSM continues to enforce valid transitions from its recovered state.
		restored.transition("WAIT");
		expect(restored.state).toBe("WAIT");
	});
});
