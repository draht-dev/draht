// Tests for `RlmSession`, the RLM root loop (see
// .planning/phases/26-rlm-core-primitives/26-01-PLAN.md, Architecture
// section 4). `rootLlm` (and, where relevant, `llmQuery`) are mocked here --
// real @draht/router wiring lands in Phase 27 -- but each test drives a real
// `python3` repl_driver.py subprocess underneath, so these exercise the full
// spawn -> seed `context` -> exec -> FINAL/FINAL_VAR loop end to end.

import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import type { RlmHistoryEntry } from "../src/index.js";
import { RlmSession } from "../src/index.js";

describe("RlmSession root loop", () => {
	let session: RlmSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	test("1. needle-in-haystack: FINAL() resolves the marker's associated value found in context", async () => {
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(200);
		const prompt = `${filler}\n<<NEEDLE:the-secret-answer-is-42>>\n${filler}`;

		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			[
				"```repl",
				"import re",
				"match = re.search(r'<<NEEDLE:(.*?)>>', context)",
				"FINAL(match.group(1))",
				"```",
			].join("\n");

		session = new RlmSession({ prompt, rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final");
		expect(result.value).toBe("the-secret-answer-is-42");
		expect(result.steps).toBe(1);
	});

	test("2. variables persist across step() calls through the session (not just the driver)", async () => {
		let turn = 0;
		const rootLlm = async (_history: RlmHistoryEntry[]) => {
			turn += 1;
			if (turn === 1) return ["```python", "counter = 10", "```"].join("\n");
			return ["```python", "counter += 5", "FINAL(counter)", "```"].join("\n");
		};

		session = new RlmSession({ prompt: "unused for this test", rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final");
		// FINAL(answer) sends str(answer) -- 15 comes back as the string "15".
		expect(result.value).toBe("15");
		expect(result.steps).toBe(2);
	});

	test("3. the context variable holds the exact full prompt string", async () => {
		const prompt = "abc def ghi ".repeat(37);
		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			["```python", "n = len(context)", "FINAL_VAR('n')", "```"].join("\n");

		session = new RlmSession({ prompt, rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final_var");
		// Parsed back from the repr'd int into a real JS number, not the
		// string "444" -- see pythonReprToValue's doc comment in session.ts.
		expect(result.value).toBe(prompt.length);
	});

	test("4. llm_query(prompt) round-trips through the injectable llmQuery callback", async () => {
		const llmQuery = async (prompt: string) => `canned-response-for:${prompt}`;
		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			["```python", "result = llm_query('2+2?')", "FINAL(result)", "```"].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm, llmQuery });
		const result = await session.run();

		expect(result.kind).toBe("final");
		expect(result.value).toBe("canned-response-for:2+2?");
	});

	test("5. FINAL_VAR resolves a repr'd compound value back into a real JS value", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			["```python", "ans = [1, 2, 'three', None, True]", "FINAL_VAR('ans')", "```"].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final_var");
		expect(result.value).toEqual([1, 2, "three", null, true]);
	});

	test("6. run() stops at maxIterations when rootLlm never calls FINAL", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) => ["```python", "pass", "```"].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm, maxIterations: 3 });
		const result = await session.run();

		expect(result.kind).toBe("max_iterations");
		expect(result.steps).toBe(3);
		expect(result.history).toHaveLength(3);
	});

	test("7. parses both ```repl and ```python fenced blocks out of a prose-wrapped response", async () => {
		let turn = 0;
		const rootLlm = async (_history: RlmHistoryEntry[]) => {
			turn += 1;
			if (turn === 1) {
				return [
					"Let me look at this step by step, I'll stash a value for later.",
					"",
					"```repl",
					"value = 'from-repl-fence'",
					"```",
					"",
					"I'll use that on the next turn.",
				].join("\n");
			}
			return ["Now finishing up.", "", "```python", "FINAL(value)", "```"].join("\n");
		};

		session = new RlmSession({ prompt: "unused for this test", rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final");
		expect(result.value).toBe("from-repl-fence");
		expect(result.steps).toBe(2);
	});

	test("8. dispose() terminates the underlying python3 subprocess", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) => ["```python", "FINAL('done')", "```"].join("\n");
		session = new RlmSession({ prompt: "unused for this test", rootLlm });
		await session.run();

		const child = (session as unknown as { child: ChildProcess }).child;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});

		session.dispose();
		await exited;

		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});
});
