import { describe, expect, it } from "vitest";
import { TaskBoard, type TaskBoardEvent } from "../../src/core/multi-agent/task-board.ts";

describe("TaskBoard", () => {
	it("posts a task with requirements", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: { agentType: "implementer" }, description: "impl feature" });

		expect(typeof taskId).toBe("string");
		expect(taskId.length).toBeGreaterThan(0);

		const task = board.get(taskId);
		expect(task?.status).toBe("pending");
		expect(task?.requirements.agentType).toBe("implementer");
	});

	it("lets an agent self-assign a matching task, moving it to assigned", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: { agentType: "implementer" } });

		const claimed = board.claim("agent-1", { agentType: "implementer" });

		expect(claimed?.id).toBe(taskId);
		expect(claimed?.status).toBe("assigned");
		expect(claimed?.assignedTo).toBe("agent-1");
		expect(board.get(taskId)?.status).toBe("assigned");
	});

	it("does not self-assign a task whose requirements don't match", () => {
		const board = new TaskBoard();
		board.post({ requirements: { agentType: "reviewer" } });

		const claimed = board.claim("agent-1", { agentType: "implementer" });

		expect(claimed).toBeUndefined();
	});

	it("returns an error on double-assign of the same task", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: { agentType: "implementer" } });

		const first = board.assign(taskId, "agent-1");
		expect(first.ok).toBe(true);

		const second = board.assign(taskId, "agent-2");
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.error).toBeTruthy();
		}

		// still assigned to the first agent, unaffected by the failed second attempt
		expect(board.get(taskId)?.assignedTo).toBe("agent-1");
	});

	it("completes a task, storing the result", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: { agentType: "implementer" } });
		board.assign(taskId, "agent-1");

		const result = board.complete(taskId, { summary: "done" });

		expect(result.ok).toBe(true);
		const task = board.get(taskId);
		expect(task?.status).toBe("done");
		expect(task?.result).toEqual({ summary: "done" });
	});

	it("fails a task, storing the error", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: { agentType: "implementer" } });
		board.assign(taskId, "agent-1");

		const result = board.fail(taskId, "boom");

		expect(result.ok).toBe(true);
		const task = board.get(taskId);
		expect(task?.status).toBe("failed");
		expect(task?.error).toBe("boom");
	});

	it("lists tasks by status", () => {
		const board = new TaskBoard();
		const pendingId = board.post({ requirements: {} });
		const assignedId = board.post({ requirements: {} });
		const doneId = board.post({ requirements: {} });
		const failedId = board.post({ requirements: {} });

		board.assign(assignedId, "agent-1");

		board.assign(doneId, "agent-2");
		board.complete(doneId, { ok: true });

		board.assign(failedId, "agent-3");
		board.fail(failedId, "err");

		expect(board.list("pending").map((t) => t.id)).toEqual([pendingId]);
		expect(board.list("assigned").map((t) => t.id)).toEqual([assignedId]);
		expect(board.list("done").map((t) => t.id)).toEqual([doneId]);
		expect(board.list("failed").map((t) => t.id)).toEqual([failedId]);
		expect(board.list()).toHaveLength(4);
	});

	it("cancels a pending task", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: {} });

		const result = board.cancel(taskId);

		expect(result.ok).toBe(true);
		expect(board.get(taskId)?.status).toBe("cancelled");
		expect(board.list("cancelled").map((t) => t.id)).toEqual([taskId]);
	});

	it("refuses to cancel a task that already finished", () => {
		const board = new TaskBoard();
		const taskId = board.post({ requirements: {} });
		board.assign(taskId, "agent-1");
		board.complete(taskId, {});

		const result = board.cancel(taskId);

		expect(result.ok).toBe(false);
		expect(board.get(taskId)?.status).toBe("done");
	});

	it("emits posted, assigned, completed, and failed events", () => {
		const board = new TaskBoard();
		const events: TaskBoardEvent[] = [];
		board.onEvent((event) => events.push(event));

		const taskId = board.post({ requirements: { agentType: "implementer" } });
		board.assign(taskId, "agent-1");
		board.complete(taskId, { ok: true });

		const taskId2 = board.post({ requirements: {} });
		board.assign(taskId2, "agent-2");
		board.fail(taskId2, "nope");

		expect(events.map((e) => e.type)).toEqual(["posted", "assigned", "completed", "posted", "assigned", "failed"]);
	});
});
