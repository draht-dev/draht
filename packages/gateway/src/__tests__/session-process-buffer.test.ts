/**
 * Tests for SessionProcess output buffering and replay
 */

import { describe, expect, test } from "bun:test";
import { SessionProcess } from "../session/session-process";

describe("SessionProcess output buffering", () => {
	test("late subscriber receives buffered output from the beginning", async () => {
		const proc = new SessionProcess(["sh", "-c", "echo line1; echo line2; sleep 0.1; echo line3"]);
		await proc.ready;

		// Wait for some output to be produced
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Subscribe late (after some output has been produced)
		const lateOutputs: string[] = [];
		proc.onOutput((data) => {
			lateOutputs.push(data);
		});

		// Wait for remaining output
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Late subscriber should have received ALL output (buffered + live)
		const allOutput = lateOutputs.join("");
		expect(allOutput).toContain("line1");
		expect(allOutput).toContain("line2");
		expect(allOutput).toContain("line3");

		proc.kill();
	});

	test("multiple late subscribers each get full buffered output", async () => {
		const proc = new SessionProcess(["echo", "hello world"]);
		await proc.ready;

		// Wait for output to be produced
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Subscribe two late subscribers
		const outputs1: string[] = [];
		const outputs2: string[] = [];

		proc.onOutput((data) => outputs1.push(data));
		proc.onOutput((data) => outputs2.push(data));

		// Wait a bit more
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Both should have received the same output
		expect(outputs1.join("")).toContain("hello world");
		expect(outputs2.join("")).toContain("hello world");
		expect(outputs1.join("")).toBe(outputs2.join(""));

		await proc.exited;
	});

	test("subscriber added before output gets output once (not duplicated)", async () => {
		const proc = new SessionProcess(["cat"]);
		await proc.ready;

		const outputs: string[] = [];
		proc.onOutput((data) => outputs.push(data));

		// Write input
		proc.write("test\n");

		// Wait for echo
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Should have received the output exactly once
		const allOutput = outputs.join("");
		expect(allOutput).toBe("test\n");

		// Count occurrences to ensure no duplication
		const count = (allOutput.match(/test/g) || []).length;
		expect(count).toBe(1);

		proc.kill();
	});
});
