import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentConfig,
	type AgentRunContext,
	type AgentRunner,
	createRunMailbox,
	multiAgentState,
	onAgentFsmTransition,
	type RunResult,
	runChainTasks,
	runParallelTasks,
	runSingleTask,
	SUBAGENT_RESULT_MAILBOX,
} from "../../src/core/builtins/subagent.ts";
import type { AgentFSMTransitionEvent } from "../../src/core/multi-agent/index.ts";
import { WORKTREE_DIR_NAME } from "../../src/core/multi-agent/worktree.ts";
import { AgentLimiter } from "../../src/core/polyphase/limiter.ts";
import { createTempGitRepo, type TempGitRepo } from "../test-utils/git-repo.ts";

function makeAgent(name = "worker"): AgentConfig {
	return { name, description: "test agent", systemPrompt: "", source: "project" };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Collects the FSM transitions for one agentId and an idempotent unsubscribe. */
function trackFsm(agentId: string): { events: AgentFSMTransitionEvent[]; stop: () => void } {
	const events: AgentFSMTransitionEvent[] = [];
	const unsubscribe = onAgentFsmTransition((event) => {
		if (event.agentId === agentId) events.push(event);
	});
	return { events, stop: unsubscribe };
}

describe("lifecycle robustness: throws inside the try block", () => {
	it("a runner that throws ends the FSM in IDLE, deregisters the mailbox, releases the limiter, and fails with the error in stderr", async () => {
		const agentId = `robust-runner-throw-${randomUUID()}`;
		const { events, stop } = trackFsm(agentId);
		const limiter = new AgentLimiter(2);
		const finishes: RunResult[] = [];
		const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };

		const runner: AgentRunner = async () => {
			throw new Error("runner exploded");
		};

		const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", { runner, agentId, limiter, run });

		stop();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("runner exploded");
		expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
			"IDLE->REQUEST",
			"REQUEST->WORKING",
			"WORKING->RESPOND",
			"RESPOND->IDLE",
		]);
		expect(multiAgentState.mailbox.isRegistered(agentId)).toBe(false);
		expect(limiter.stats().active).toBe(0);
		expect(finishes).toEqual([result]);
	});

	it("a worktree.create that throws ends the FSM in IDLE, deregisters the mailbox, releases the limiter, and fails with the error in stderr", async () => {
		const repo: TempGitRepo = createTempGitRepo();
		try {
			const agentId = "robust-worktree-throw";
			// Pre-create a non-empty directory at the exact path `worktree add` would use, so the
			// underlying `git worktree add` command fails deterministically.
			const collisionDir = join(repo.repoPath, WORKTREE_DIR_NAME, agentId);
			mkdirSync(collisionDir, { recursive: true });
			writeFileSync(join(collisionDir, "blocker.txt"), "occupied");

			const { events, stop } = trackFsm(agentId);
			const limiter = new AgentLimiter(2);
			const finishes: RunResult[] = [];
			const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };
			const runner: AgentRunner = async (_cwd, agent, task) => ({
				agent: agent.name,
				task,
				exitCode: 0,
				output: "should not run",
				stderr: "",
			});

			const result = await runSingleTask(repo.repoPath, makeAgent(), "do the thing", {
				runner,
				agentId,
				worktree: true,
				limiter,
				run,
			});

			stop();
			expect(result.exitCode).toBe(1);
			expect(result.output).toBe("");
			expect(result.stderr).toMatch(/worktree|already exists/i);
			expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
				"IDLE->REQUEST",
				"REQUEST->WORKING",
				"WORKING->RESPOND",
				"RESPOND->IDLE",
			]);
			expect(multiAgentState.mailbox.isRegistered(agentId)).toBe(false);
			expect(limiter.stats().active).toBe(0);
			expect(finishes).toEqual([result]);
		} finally {
			repo.cleanup();
		}
	});

	it("a worktree merge that throws still releases the limiter and cleans up the worktree, losing the runner's successful output per the design", async () => {
		const repo: TempGitRepo = createTempGitRepo();
		try {
			const agentId = `robust-merge-throw-${randomUUID()}`;
			const { events, stop } = trackFsm(agentId);
			const limiter = new AgentLimiter(2);
			const finishes: RunResult[] = [];
			const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };
			const runner: AgentRunner = async (_cwd, agent, task) => ({
				agent: agent.name,
				task,
				exitCode: 0,
				output: "agent's work",
				stderr: "",
			});
			const mergeSpy = vi.spyOn(multiAgentState.worktree, "merge").mockImplementation(() => {
				throw new Error("merge exploded");
			});

			const result = await runSingleTask(repo.repoPath, makeAgent(), "do the thing", {
				runner,
				agentId,
				worktree: true,
				limiter,
				run,
			});

			stop();
			mergeSpy.mockRestore();

			expect(result.exitCode).toBe(1);
			expect(result.output).toBe("");
			expect(result.stderr).toBe("merge exploded");
			expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
				"IDLE->REQUEST",
				"REQUEST->WORKING",
				"WORKING->RESPOND",
				"RESPOND->IDLE",
			]);
			expect(multiAgentState.mailbox.isRegistered(agentId)).toBe(false);
			expect(limiter.stats().active).toBe(0);
			expect(finishes).toEqual([result]);
			// Cleanup ran despite the throw: the worktree directory for this task is gone.
			expect(existsSync(join(repo.repoPath, WORKTREE_DIR_NAME, agentId))).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	it("a listener registered via onAgentFsmTransition that throws does not block the lease release or mailbox deregistration", async () => {
		const agentId = `robust-listener-throw-${randomUUID()}`;
		const limiter = new AgentLimiter(2);
		const finishes: RunResult[] = [];
		const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };
		const unsubscribe = onAgentFsmTransition(() => {
			throw new Error("listener exploded");
		});

		const runner: AgentRunner = async (_cwd, agent, task) => ({
			agent: agent.name,
			task,
			exitCode: 0,
			output: "done",
			stderr: "",
		});

		try {
			const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", {
				runner,
				agentId,
				limiter,
				run,
			});

			expect(result.exitCode).toBe(0);
			expect(multiAgentState.mailbox.isRegistered(agentId)).toBe(false);
			expect(limiter.stats().active).toBe(0);
			expect(finishes).toEqual([result]);
		} finally {
			unsubscribe();
		}
	});
});

describe("lifecycle robustness: pre-abort and queued-abort", () => {
	it("a pre-aborted signal never calls the runner and resolves cancelled", async () => {
		const calls: unknown[] = [];
		const runner: AgentRunner = async (...args) => {
			calls.push(args);
			return { agent: "x", task: "y", exitCode: 0, output: "", stderr: "" };
		};
		const controller = new AbortController();
		controller.abort();
		const finishes: RunResult[] = [];
		const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };

		const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", {
			runner,
			signal: controller.signal,
			run,
		});

		expect(calls).toHaveLength(0);
		expect(result).toEqual({
			agent: "worker",
			task: "do the thing",
			exitCode: 1,
			output: "",
			stderr: "cancelled",
			cancelled: true,
			step: undefined,
		});
		expect(finishes).toEqual([result]);
	});

	it("aborting while queued on a capacity-1 limiter never calls the runner and returns cancelled", async () => {
		const limiter = new AgentLimiter(1);
		const occupying = await limiter.acquire();

		const calls: unknown[] = [];
		const runner: AgentRunner = async (...args) => {
			calls.push(args);
			return { agent: "x", task: "y", exitCode: 0, output: "", stderr: "" };
		};
		const controller = new AbortController();
		const finishes: RunResult[] = [];
		const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };

		const resultPromise = runSingleTask("/fake/cwd", makeAgent(), "do the thing", {
			runner,
			limiter,
			signal: controller.signal,
			run,
		});
		// The synchronous portion of `limiter.acquire()` has already queued the waiter by the time
		// `runSingleTask(...)` returns its promise (acquiring is only asynchronous once it suspends
		// at `await`), so aborting here targets the queued waiter, not a not-yet-registered one.
		controller.abort();

		const result = await resultPromise;

		expect(calls).toHaveLength(0);
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("cancelled");
		expect(finishes).toEqual([result]);

		occupying.release();
		expect(limiter.stats().active).toBe(0);
	});

	it("a non-LimiterAbortedError acquire rejection (e.g. session.dispose's rejectAll) resolves failed instead of throwing", async () => {
		const limiter = new AgentLimiter(1);
		const occupying = await limiter.acquire();

		const calls: unknown[] = [];
		const runner: AgentRunner = async (...args) => {
			calls.push(args);
			return { agent: "x", task: "y", exitCode: 0, output: "", stderr: "" };
		};
		const finishes: RunResult[] = [];
		const run: AgentRunContext = { onFinish: (result) => finishes.push(result) };

		const resultPromise = runSingleTask("/fake/cwd", makeAgent(), "do the thing", { runner, limiter, run });
		limiter.rejectAll(new Error("session disposed: shutdown"));

		const result = await resultPromise;

		expect(calls).toHaveLength(0);
		expect(result.cancelled).toBeUndefined();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("session disposed: shutdown");
		expect(finishes).toEqual([result]);

		occupying.release();
	});
});

describe("lifecycle robustness: {previous} substitution", () => {
	it("passes '$&' and '$1' in the previous output through to the next step literally", async () => {
		let secondStepTask: string | undefined;

		const runner: AgentRunner = async (_cwd, agent, task, _signal, step) => {
			if (step === 1) {
				return { agent: agent.name, task, exitCode: 0, output: "value $& and $1 stay literal", stderr: "" };
			}
			secondStepTask = task;
			return { agent: agent.name, task, exitCode: 0, output: "done", stderr: "" };
		};

		await runChainTasks(
			"/fake/cwd",
			[
				{ agent: makeAgent("producer"), task: "produce" },
				{ agent: makeAgent("consumer"), task: "use {previous}" },
			],
			{ runner },
		);

		expect(secondStepTask).toBe("use value $& and $1 stay literal");
	});
});

describe("lifecycle robustness: runParallelTasks per-item throws and pool sizing", () => {
	it("a per-item throw becomes a failed result while the other items complete, and fails the posted task instead of leaving it assigned", async () => {
		const items = [
			{ agent: makeAgent("a0"), task: "t0" },
			{ agent: makeAgent("a1"), task: "t1" },
			{ agent: makeAgent("a2"), task: "t2" },
		];
		const runner: AgentRunner = async (_cwd, agent, task) => ({
			agent: agent.name,
			task,
			exitCode: 0,
			output: `done:${task}`,
			stderr: "",
		});

		const assignedTaskIds: string[] = [];
		const stopBoardListener = multiAgentState.board.onEvent((event) => {
			if (event.type === "assigned") assignedTaskIds.push(event.task.id);
		});

		const results = await runParallelTasks("/fake/cwd", items, {
			runner,
			perItem: (i) => {
				if (i === 1) throw new Error("boom");
				return {};
			},
		});

		stopBoardListener();
		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({ exitCode: 0, output: "done:t0" });
		expect(results[1]).toMatchObject({ exitCode: 1, stderr: "boom" });
		expect(results[2]).toMatchObject({ exitCode: 0, output: "done:t2" });

		// The throw happened after `taskBoard.assign`, so without a fix the board entry would stay
		// "assigned" forever instead of being failed alongside the returned RunResult.
		expect(assignedTaskIds).toHaveLength(3);
		expect(multiAgentState.board.get(assignedTaskIds[1])).toMatchObject({ status: "failed", error: "boom" });
	});

	it("uses a pool equal to items.length (not MAX_CONCURRENCY) when a limiter is passed", async () => {
		const limiter = new AgentLimiter(1);
		const items = Array.from({ length: 5 }, (_, i) => ({ agent: makeAgent(`a${i}`), task: `t${i}` }));
		const queuedIndexes = new Set<number>();
		const gate = createDeferred<void>();

		const runner: AgentRunner = async (_cwd, agent, task) => {
			await gate.promise;
			return { agent: agent.name, task, exitCode: 0, output: "ok", stderr: "" };
		};

		const resultPromise = runParallelTasks("/fake/cwd", items, {
			runner,
			limiter,
			perItem: (i) => ({ run: { onQueued: () => queuedIndexes.add(i) } }),
		});

		// All 5 pool workers start synchronously (pool size = items.length), so capacity 1 queues
		// every item but the one that acquired immediately before any of them can resolve.
		expect(limiter.stats().active).toBe(1);
		expect(queuedIndexes.size).toBe(items.length - 1);

		gate.resolve();
		const results = await resultPromise;
		expect(results.every((r) => r.exitCode === 0)).toBe(true);
		expect(limiter.stats().active).toBe(0);
	});
});

describe("lifecycle robustness: onFinish and the run mailbox", () => {
	it("run.onFinish is called exactly once with the final result", async () => {
		const finishes: RunResult[] = [];
		const run: AgentRunContext = {
			onFinish: (result) => finishes.push(result),
		};
		const runner: AgentRunner = async (_cwd, agent, task) => ({
			agent: agent.name,
			task,
			exitCode: 0,
			output: "done",
			stderr: "",
		});

		const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", { runner, run });

		expect(finishes).toHaveLength(1);
		expect(finishes[0]).toEqual(result);
	});

	it("createRunMailbox registers a prefixed name and dispose drains and deregisters it idempotently", () => {
		const mailbox = createRunMailbox("lifecycle-test-run");
		expect(mailbox.name.startsWith("lifecycle-test-run-")).toBe(true);
		expect(multiAgentState.mailbox.isRegistered(mailbox.name)).toBe(true);

		multiAgentState.mailbox.send(SUBAGENT_RESULT_MAILBOX, mailbox.name, { type: "TaskResult", payload: {} });

		mailbox.dispose();
		expect(multiAgentState.mailbox.isRegistered(mailbox.name)).toBe(false);
		expect(() => mailbox.dispose()).not.toThrow();
	});
});
