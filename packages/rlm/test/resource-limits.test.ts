// Tests for the "Resource limits" task of
// .planning/phases/28-repl-sandbox-safety/28-01-PLAN.md (Architecture
// sections 3-6): Node-side RSS polling + wall-clock step timeout, the
// incremental Python-side stdout cap, diff-based rollback, and pre-dispatch
// budget checks.
//
// Like test/session.test.ts (Phase 26), `rootLlm`/`llmQuery` are mocked, but
// every test here drives a REAL `python3` repl_driver.py subprocess
// underneath (via the real OS-level sandbox wrapper, same as production) --
// nothing about resource-limit enforcement is mocked out.

import { afterEach, describe, expect, test } from "vitest";
import type { RlmHistoryEntry } from "../src/index.js";
import { RlmSession } from "../src/index.js";
import { HAS_PYTHON3, HAS_USERNS } from "./sandbox-prereqs.js";

// Every test constructs an RlmSession, which spawns python3 through the
// fail-closed OS sandbox (`spawnSandboxed`) -- see sandbox-prereqs.ts.
describe.skipIf(!HAS_PYTHON3 || !HAS_USERNS)("Resource limits (Phase 28 Architecture sections 3-6)", () => {
	let session: RlmSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	test("1. a step that spins past the configured wall-clock timeout gets killed -- result reflects a timeout stop reason", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) => ["```python", "while True:", "    pass", "```"].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm, stepTimeoutMs: 500 });
		const result = await session.run();

		expect(result.kind).toBe("timeout");
		expect(typeof result.value).toBe("string");
		expect(result.value as string).toContain("wall-clock timeout");
		// The spinning step never completed -- no history entry for it, and no
		// rollback is attempted for a hard kill (see repl_driver.py's
		// `_rollback_step` docstring).
		expect(result.steps).toBe(0);
		expect(result.history).toHaveLength(0);
	});

	test("1b. a step budget far below python startup still reports the spinning step as a timeout, not a sandbox violation", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) => ["```python", "while True:", "    pass", "```"].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm, stepTimeoutMs: 20 });
		const result = await session.run();

		expect(result.kind).toBe("timeout");
		expect(result.value as string).toContain("wall-clock timeout of 20ms");
	});

	test("2. a step allocating memory well past a deliberately small RSS ceiling gets killed", async () => {
		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			["```python", "buf = bytearray(64 * 1024 * 1024)", "while True:", "    pass", "```"].join("\n");

		// A tiny ceiling (32MB) so the test doesn't need gigabytes to trigger --
		// per the plan's task 3 test 2 note, not the real 256MB default.
		// stepTimeoutMs is generously large so this test proves the RSS kill
		// specifically, not a race against the wall-clock timeout.
		session = new RlmSession({
			prompt: "unused for this test",
			rootLlm,
			maxRssBytes: 32 * 1024 * 1024,
			rssPollIntervalMs: 50,
			stepTimeoutMs: 5000,
		});
		const result = await session.run();

		// R28-SBX.6 has no dedicated enum value for an OOM-triggered kill --
		// it's "error", with a message naming the ceiling (see session.ts /
		// RlmResultKind's doc comment for why this deliberately isn't folded
		// into "sandbox_violation").
		expect(result.kind).toBe("error");
		expect(typeof result.value).toBe("string");
		expect(result.value as string).toContain("RSS ceiling");
		expect(result.steps).toBe(0);
	});

	test("3. a step printing far more than stdoutTruncateChars doesn't balloon driver memory -- truncation marker appears and the driver stays responsive for the next step", async () => {
		let turn = 0;
		const rootLlm = async (_history: RlmHistoryEntry[]) => {
			turn += 1;
			if (turn === 1) {
				return ["```python", "for i in range(300000):", "    print('x' * 50)", "```"].join("\n");
			}
			return ["```python", "print('still alive')", "```"].join("\n");
		};

		// A small custom cap makes the assertion below unambiguous regardless
		// of the (much larger) production default.
		session = new RlmSession({ prompt: "unused for this test", rootLlm, stdoutTruncateChars: 200 });

		const first = await session.step();
		expect(first.error).toBeNull();
		expect(first.truncatedStdout.length).toBeLessThan(300);
		expect(first.truncatedStdout).toContain("[truncated");

		// Proves the cap was enforced incrementally (not after buffering
		// ~15MB of "x"s and only truncating after the fact) -- the driver is
		// still alive and responsive immediately afterward.
		const second = await session.step();
		expect(second.error).toBeNull();
		expect(second.truncatedStdout).toBe("still alive\n");
	});

	test("4. rollback: a recoverable exception after rebinding an existing variable and creating a new one restores/removes them", async () => {
		let turn = 0;
		const rootLlm = async (_history: RlmHistoryEntry[]) => {
			turn += 1;
			if (turn === 1) return ["```python", "x = 1", "y = 2", "```"].join("\n");
			if (turn === 2) {
				// Rebinds an existing name (x), creates a new one (z), then blows
				// up -- a recoverable in-process exception, not a hard kill.
				return ["```python", "x = 99", "z = 'should not survive'", "raise ValueError('boom')", "```"].join("\n");
			}
			return [
				"```python",
				"outcome = []",
				"outcome.append(x)", // must be the ORIGINAL value (1), not 99
				"try:",
				"    outcome.append(z)",
				"    outcome.append('z-survived')",
				"except NameError:",
				"    outcome.append('z-gone')",
				"FINAL_VAR('outcome')",
				"```",
			].join("\n");
		};

		session = new RlmSession({ prompt: "unused for this test", rootLlm });
		const result = await session.run();

		expect(result.kind).toBe("final_var");
		// Outcome-only assertion, per the plan's explicit note not to assert
		// anything about context's identity/size (that deep-copy behavior no
		// longer exists): x was restored to its pre-step value (1, not 99),
		// and z (created during the failed step) is gone.
		expect(result.value).toEqual([1, "z-gone"]);
		expect(result.history[1].error).toContain("ValueError: boom");
	});

	test("5. budget pre-checks: a tiny maxSubCalls stops the session with budget_exhausted at the correct call, not after overshooting", async () => {
		let dispatchedCalls = 0;
		const llmQuery = async (prompt: string) => {
			dispatchedCalls += 1;
			return `answer-for:${prompt}`;
		};
		const rootLlm = async (_history: RlmHistoryEntry[]) =>
			[
				"```python",
				"results = []",
				"for i in range(5):",
				"    results.append(llm_query(str(i)))",
				"FINAL_VAR('results')",
				"```",
			].join("\n");

		session = new RlmSession({ prompt: "unused for this test", rootLlm, llmQuery, maxSubCalls: 2 });
		const result = await session.run();

		expect(result.kind).toBe("budget_exhausted");
		expect(typeof result.value).toBe("string");
		expect(result.value as string).toContain("maxSubCalls=2");
		// Exactly 2 sub-calls were actually dispatched to llmQuery -- the 3rd
		// (would-be) attempt never reached it at all, and the loop never got
		// to attempt calls 4/5 either (stopped at the boundary, not after
		// overshooting it).
		expect(dispatchedCalls).toBe(2);
	});

	test("6. budget pre-checks: an exhausted cost budget stops the session before the next step's rootLlm is even dispatched", async () => {
		let rootLlmCalls = 0;
		const rootLlm = async (_history: RlmHistoryEntry[]) => {
			rootLlmCalls += 1;
			return ["```python", "pass", "```"].join("\n");
		};

		session = new RlmSession({
			prompt: "unused for this test",
			rootLlm,
			maxTotalCostUsd: 1,
			getAccumulatedCostUsd: () => 2, // already over budget before step 1 even runs
		});
		const result = await session.run();

		expect(result.kind).toBe("budget_exhausted");
		expect(typeof result.value).toBe("string");
		expect(result.value as string).toContain("maxTotalCostUsd");
		// rootLlm is never even called -- the pre-check fires before dispatch,
		// not after a step has already been paid for.
		expect(rootLlmCalls).toBe(0);
	});
});
