import { describe, expect, test } from "bun:test";
import { buildCropPath, composeElementContext, type ElementDescriptor } from "../../src/composer/element-context.js";

const element: ElementDescriptor = {
	tagName: "button",
	selector: "#hero > button:nth-of-type(2)",
	boundingRect: { x: 12, y: 34, width: 120, height: 40 },
};

describe("buildCropPath", () => {
	test("follows the exact <wt>/.geist/task-<id>/target.webp convention", () => {
		expect(buildCropPath("/Users/oskar/repo/.geist/wt/kintura", "abc-123")).toBe(
			"/Users/oskar/repo/.geist/wt/kintura/.geist/task-abc-123/target.webp",
		);
	});
});

describe("composeElementContext", () => {
	test("round-trips the element descriptor, page, sessionId and instruction unchanged", () => {
		const context = composeElementContext({
			element,
			page: { url: "https://kintura.local/dashboard" },
			sessionId: "session-1",
			instruction: "make this button bigger and use the accent color",
			worktreeRoot: "/repo/.geist/wt/kintura",
			taskId: "fixed-task-id",
		});

		expect(context.element).toEqual(element);
		expect(context.page).toEqual({ url: "https://kintura.local/dashboard" });
		expect(context.sessionId).toBe("session-1");
		expect(context.instruction).toBe("make this button bigger and use the accent color");
	});

	test("crop path follows the exact <wt>/.geist/task-<id>/target.webp convention with a fixed taskId", () => {
		const context = composeElementContext({
			element,
			page: { url: "https://kintura.local/dashboard" },
			sessionId: "session-1",
			instruction: "resize this",
			worktreeRoot: "/repo/.geist/wt/kintura",
			taskId: "fixed-task-id",
		});

		expect(context.taskId).toBe("fixed-task-id");
		expect(context.cropPath).toBe("/repo/.geist/wt/kintura/.geist/task-fixed-task-id/target.webp");
	});

	test("generates a fresh random taskId (and matching cropPath) when none is supplied", () => {
		const a = composeElementContext({
			element,
			page: { url: "https://kintura.local/dashboard" },
			sessionId: "session-1",
			instruction: "resize this",
			worktreeRoot: "/repo/.geist/wt/kintura",
		});
		const b = composeElementContext({
			element,
			page: { url: "https://kintura.local/dashboard" },
			sessionId: "session-1",
			instruction: "resize this",
			worktreeRoot: "/repo/.geist/wt/kintura",
		});

		// UUID v4 shape.
		expect(a.taskId).toMatch(/^[0-9a-f-]{36}$/);
		expect(a.taskId).not.toBe(b.taskId);
		expect(a.cropPath).toBe(`/repo/.geist/wt/kintura/.geist/task-${a.taskId}/target.webp`);
	});
});
