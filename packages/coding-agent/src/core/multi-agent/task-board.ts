import { randomUUID } from "crypto";

/** Lifecycle of a posted task. */
export type TaskStatus = "pending" | "assigned" | "done" | "failed" | "cancelled";

/** Requirements a task declares; agents self-assign only tasks they satisfy. */
export interface TaskRequirements {
	agentType?: string;
	capabilities?: string[];
}

/** What an agent offers when asking the board to self-assign work. */
export interface AgentCapabilities {
	agentType?: string;
	capabilities?: string[];
}

/** Input to `TaskBoard.post()`. */
export interface TaskSpec {
	requirements?: TaskRequirements;
	description?: string;
	payload?: unknown;
}

/** A task tracked by the board. */
export interface Task {
	id: string;
	status: TaskStatus;
	requirements: TaskRequirements;
	description?: string;
	payload?: unknown;
	assignedTo?: string;
	result?: unknown;
	error?: string;
	createdAt: number;
	updatedAt: number;
}

export type TaskBoardEvent =
	| { type: "posted"; task: Task }
	| { type: "assigned"; task: Task; agentId: string }
	| { type: "completed"; task: Task; result: unknown }
	| { type: "failed"; task: Task; error: string }
	| { type: "cancelled"; task: Task };

export type TaskBoardListener = (event: TaskBoardEvent) => void;

/** Result of a mutating call: `ok: true` with the updated task, or `ok: false` with a reason. */
export type TaskBoardResult = { ok: true; task: Task } | { ok: false; error: string };

/** True when a task's requirements are satisfied by an agent's offered capabilities. */
function matches(requirements: TaskRequirements, offered: AgentCapabilities): boolean {
	if (requirements.agentType && requirements.agentType !== offered.agentType) return false;
	if (requirements.capabilities && requirements.capabilities.length > 0) {
		const have = new Set(offered.capabilities ?? []);
		if (!requirements.capabilities.every((cap) => have.has(cap))) return false;
	}
	return true;
}

/**
 * Autonomous task board: tasks are posted with requirements, agents self-assign
 * (or are explicitly assigned) with an atomic pending → assigned check, and
 * completion/failure/cancellation is tracked. Board state changes are
 * observable via `onEvent()`.
 *
 * Single-process only: locking is a synchronous status check, not a
 * cross-process file lock. Cross-process safety is left to a future backing
 * store (see phase plan risks).
 */
export class TaskBoard {
	private readonly tasks = new Map<string, Task>();
	private readonly listeners = new Set<TaskBoardListener>();

	/** Post a new task in `pending` status. Returns its id. */
	post(spec: TaskSpec): string {
		const now = Date.now();
		const task: Task = {
			id: randomUUID(),
			status: "pending",
			requirements: spec.requirements ?? {},
			description: spec.description,
			payload: spec.payload,
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(task.id, task);
		this.emit({ type: "posted", task: clone(task) });
		return task.id;
	}

	/** Look up a task by id. Returns a copy; mutate via the board's methods. */
	get(taskId: string): Task | undefined {
		const task = this.tasks.get(taskId);
		return task ? clone(task) : undefined;
	}

	/**
	 * Explicitly assign a specific task to an agent. Atomic: fails if the task
	 * is not currently `pending` (already assigned, done, failed, or cancelled).
	 */
	assign(taskId: string, agentId: string): TaskBoardResult {
		const task = this.tasks.get(taskId);
		if (!task) return { ok: false, error: `Task not found: ${taskId}` };
		if (task.status !== "pending") {
			return { ok: false, error: `Task ${taskId} is not pending (status: ${task.status})` };
		}
		task.status = "assigned";
		task.assignedTo = agentId;
		task.updatedAt = Date.now();
		this.emit({ type: "assigned", task: clone(task), agentId });
		return { ok: true, task: clone(task) };
	}

	/**
	 * Self-assign: find the first pending task whose requirements are satisfied
	 * by the agent's offered capabilities and atomically assign it. Returns
	 * undefined when no pending task matches.
	 */
	claim(agentId: string, offered: AgentCapabilities): Task | undefined {
		for (const task of this.tasks.values()) {
			if (task.status === "pending" && matches(task.requirements, offered)) {
				const result = this.assign(task.id, agentId);
				if (result.ok) return result.task;
			}
		}
		return undefined;
	}

	/** Mark a task done and store its result. */
	complete(taskId: string, result: unknown): TaskBoardResult {
		const task = this.tasks.get(taskId);
		if (!task) return { ok: false, error: `Task not found: ${taskId}` };
		task.status = "done";
		task.result = result;
		task.updatedAt = Date.now();
		this.emit({ type: "completed", task: clone(task), result });
		return { ok: true, task: clone(task) };
	}

	/** Mark a task failed and store the error. */
	fail(taskId: string, error: string): TaskBoardResult {
		const task = this.tasks.get(taskId);
		if (!task) return { ok: false, error: `Task not found: ${taskId}` };
		task.status = "failed";
		task.error = error;
		task.updatedAt = Date.now();
		this.emit({ type: "failed", task: clone(task), error });
		return { ok: true, task: clone(task) };
	}

	/** Cancel a task that hasn't finished yet (pending or assigned). */
	cancel(taskId: string): TaskBoardResult {
		const task = this.tasks.get(taskId);
		if (!task) return { ok: false, error: `Task not found: ${taskId}` };
		if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
			return { ok: false, error: `Task ${taskId} cannot be cancelled (status: ${task.status})` };
		}
		task.status = "cancelled";
		task.updatedAt = Date.now();
		this.emit({ type: "cancelled", task: clone(task) });
		return { ok: true, task: clone(task) };
	}

	/** List tasks, optionally filtered by status, in post order. */
	list(status?: TaskStatus): Task[] {
		const all = [...this.tasks.values()];
		const filtered = status ? all.filter((t) => t.status === status) : all;
		return filtered.map(clone);
	}

	/** Subscribe to board events. Returns an unsubscribe function. */
	onEvent(listener: TaskBoardListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: TaskBoardEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("TaskBoard event handler error:", err);
			}
		}
	}
}

function clone(task: Task): Task {
	return { ...task };
}
