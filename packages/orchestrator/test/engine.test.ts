import assert from "node:assert";
import { describe, it } from "node:test";
import type { SubTask } from "../src/types.js";

// Test topological sort (extracted for testability)

function topologicalSort(subTasks: SubTask[]): SubTask[] {
	const taskMap = new Map(subTasks.map((t) => [t.id, t]));
	const visited = new Set<string>();
	const result: SubTask[] = [];

	const visit = (id: string) => {
		if (visited.has(id)) return;
		visited.add(id);
		const task = taskMap.get(id);
		if (!task) return;
		for (const dep of task.dependsOn) {
			visit(dep);
		}
		result.push(task);
	};

	for (const task of subTasks) {
		visit(task.id);
	}

	return result;
}

function makeTask(id: string, dependsOn: string[] = []): SubTask {
	return {
		id,
		title: `Task ${id}`,
		description: `Description for ${id}`,
		agentType: "implement",
		dependsOn,
		status: "pending",
	};
}

describe("topologicalSort", () => {
	it("returns empty for no tasks", () => {
		assert.deepStrictEqual(topologicalSort([]), []);
	});

	it("returns single task as-is", () => {
		const tasks = [makeTask("a")];
		const sorted = topologicalSort(tasks);
		assert.strictEqual(sorted.length, 1);
		assert.strictEqual(sorted[0].id, "a");
	});

	it("orders independent tasks in input order", () => {
		const tasks = [makeTask("a"), makeTask("b"), makeTask("c")];
		const sorted = topologicalSort(tasks);
		assert.strictEqual(sorted.length, 3);
	});

	it("puts dependencies before dependents", () => {
		const tasks = [makeTask("b", ["a"]), makeTask("a")];
		const sorted = topologicalSort(tasks);
		const aIndex = sorted.findIndex((t) => t.id === "a");
		const bIndex = sorted.findIndex((t) => t.id === "b");
		assert.ok(aIndex < bIndex, `a (${aIndex}) should come before b (${bIndex})`);
	});

	it("handles diamond dependency", () => {
		// a → b, a → c, b → d, c → d
		const tasks = [makeTask("d", ["b", "c"]), makeTask("b", ["a"]), makeTask("c", ["a"]), makeTask("a")];
		const sorted = topologicalSort(tasks);
		const ids = sorted.map((t) => t.id);
		assert.ok(ids.indexOf("a") < ids.indexOf("b"));
		assert.ok(ids.indexOf("a") < ids.indexOf("c"));
		assert.ok(ids.indexOf("b") < ids.indexOf("d"));
		assert.ok(ids.indexOf("c") < ids.indexOf("d"));
	});

	it("handles linear chain", () => {
		const tasks = [makeTask("c", ["b"]), makeTask("b", ["a"]), makeTask("a")];
		const sorted = topologicalSort(tasks);
		assert.deepStrictEqual(
			sorted.map((t) => t.id),
			["a", "b", "c"],
		);
	});

	it("handles missing dependency gracefully", () => {
		const tasks = [makeTask("b", ["nonexistent"]), makeTask("a")];
		// Should not throw
		const sorted = topologicalSort(tasks);
		assert.strictEqual(sorted.length, 2);
	});
});
