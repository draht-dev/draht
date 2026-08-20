import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentConfig,
	type AgentRunner,
	createPermissionGateToolCallHandler,
	describeMergeFailure,
	multiAgentState,
	onAgentFsmTransition,
	type RunResult,
	runChainTasks,
	runParallelTasks,
	runSingleTask,
	SUBAGENT_RESULT_MAILBOX,
} from "../../src/core/builtins/subagent.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	type AgentFSMTransitionEvent,
	PermissionGate,
	parseRules,
	WORKTREE_DIR_NAME,
} from "../../src/core/multi-agent/index.ts";
import { createTempGitRepo, type TempGitRepo } from "../test-utils/git-repo.ts";

function makeAgent(name = "worker"): AgentConfig {
	return { name, description: "test agent", systemPrompt: "", source: "project" };
}

/** A fake `AgentRunner` that resolves instantly instead of spawning a real subprocess. */
function makeFakeRunner(overrides: Partial<RunResult> = {}): {
	runner: AgentRunner;
	calls: Array<{ cwd: string; agent: AgentConfig; task: string }>;
} {
	const calls: Array<{ cwd: string; agent: AgentConfig; task: string }> = [];
	const runner: AgentRunner = async (cwd, agent, task) => {
		calls.push({ cwd, agent, task });
		return { agent: agent.name, task, exitCode: 0, output: `done:${task}`, stderr: "", ...overrides };
	};
	return { runner, calls };
}

describe("multi-agent integration: single task", () => {
	it("drives the FSM through IDLE -> REQUEST -> WORKING -> RESPOND -> IDLE and delivers a TaskResult to the mailbox", async () => {
		const agentId = `single-test-${randomUUID()}`;
		const events: AgentFSMTransitionEvent[] = [];
		const unsubscribe = onAgentFsmTransition((event) => {
			if (event.agentId === agentId) events.push(event);
		});
		multiAgentState.mailbox.drain(SUBAGENT_RESULT_MAILBOX); // clear any messages left by other tests

		const { runner } = makeFakeRunner();
		const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", { runner, agentId });

		unsubscribe();

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("done:do the thing");
		expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
			"IDLE->REQUEST",
			"REQUEST->WORKING",
			"WORKING->RESPOND",
			"RESPOND->IDLE",
		]);

		const messages = multiAgentState.mailbox.drain(SUBAGENT_RESULT_MAILBOX);
		expect(messages).toHaveLength(1);
		expect(messages[0].type).toBe("TaskResult");
		expect(messages[0].from).toBe(agentId);
		expect((messages[0].payload as RunResult).output).toBe("done:do the thing");
	});

	it("delivers an Abort message to the mailbox when the run fails", async () => {
		const agentId = `single-fail-${randomUUID()}`;
		multiAgentState.mailbox.drain(SUBAGENT_RESULT_MAILBOX);

		const { runner } = makeFakeRunner({ exitCode: 1, output: "", stderr: "boom" });
		const result = await runSingleTask("/fake/cwd", makeAgent(), "do the thing", { runner, agentId });

		expect(result.exitCode).toBe(1);
		const messages = multiAgentState.mailbox.drain(SUBAGENT_RESULT_MAILBOX);
		expect(messages).toHaveLength(1);
		expect(messages[0].type).toBe("Abort");
	});
});

describe("multi-agent integration: parallel tasks", () => {
	it("gives each task its own FSM and tracks every assignment on the task board", async () => {
		const agentTypeA = `typeA-${randomUUID()}`;
		const agentTypeB = `typeB-${randomUUID()}`;
		const items = [
			{ agent: makeAgent(agentTypeA), task: "task-a" },
			{ agent: makeAgent(agentTypeB), task: "task-b" },
		];

		const seenAgentIds = new Set<string>();
		const unsubscribe = onAgentFsmTransition((event) => {
			if (event.agentId.startsWith("parallel-")) seenAgentIds.add(event.agentId);
		});

		const { runner } = makeFakeRunner();
		const results = await runParallelTasks("/fake/cwd", items, { runner });

		unsubscribe();

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.exitCode === 0)).toBe(true);
		// Each parallel run got its own FSM (distinct agentId).
		expect(seenAgentIds.size).toBe(2);

		const doneTasks = multiAgentState.board
			.list("done")
			.filter((t) => t.requirements.agentType === agentTypeA || t.requirements.agentType === agentTypeB);
		expect(doneTasks).toHaveLength(2);
		expect(doneTasks.every((t) => typeof t.assignedTo === "string" && t.assignedTo?.startsWith("parallel-"))).toBe(
			true,
		);
	});

	it("marks a task board entry as failed when the underlying run fails", async () => {
		const agentType = `typeFail-${randomUUID()}`;
		const { runner } = makeFakeRunner({ exitCode: 1, output: "", stderr: "nope" });

		await runParallelTasks("/fake/cwd", [{ agent: makeAgent(agentType), task: "will fail" }], { runner });

		const failed = multiAgentState.board.list("failed").filter((t) => t.requirements.agentType === agentType);
		expect(failed).toHaveLength(1);
		expect(failed[0].error).toBe("nope");
	});
});

describe("multi-agent integration: chain tasks", () => {
	it("runs steps sequentially, each with its own FSM, resolving {previous} via the mailbox", async () => {
		const seenTasks: string[] = [];
		const runner: AgentRunner = async (_cwd, agent, task) => {
			seenTasks.push(task);
			return { agent: agent.name, task, exitCode: 0, output: `output-of(${task})`, stderr: "" };
		};

		const steps = [
			{ agent: makeAgent("step1"), task: "first" },
			{ agent: makeAgent("step2"), task: "use {previous}" },
		];

		const workingOrder: string[] = [];
		const unsubscribe = onAgentFsmTransition((event) => {
			if (event.agentId.startsWith("chain-") && event.to === "WORKING" && !workingOrder.includes(event.agentId)) {
				workingOrder.push(event.agentId);
			}
		});

		const drainSpy = vi.spyOn(multiAgentState.mailbox, "drain");
		const results = await runChainTasks("/fake/cwd", steps, { runner });
		unsubscribe();

		expect(results).toHaveLength(2);
		expect(seenTasks).toEqual(["first", "use output-of(first)"]);
		expect(drainSpy).toHaveBeenCalled();
		expect(workingOrder[0]).toMatch(/^chain-0-/);
		expect(workingOrder[1]).toMatch(/^chain-1-/);

		drainSpy.mockRestore();
	});

	it("stops at the first failed step without running later steps", async () => {
		const seenTasks: string[] = [];
		const runner: AgentRunner = async (_cwd, agent, task) => {
			seenTasks.push(task);
			const failing = task === "boom";
			return {
				agent: agent.name,
				task,
				exitCode: failing ? 1 : 0,
				output: failing ? "" : `output-of(${task})`,
				stderr: failing ? "failed here" : "",
			};
		};

		const steps = [
			{ agent: makeAgent("step1"), task: "boom" },
			{ agent: makeAgent("step2"), task: "never runs" },
		];

		const results = await runChainTasks("/fake/cwd", steps, { runner });

		expect(seenTasks).toEqual(["boom"]);
		expect(results).toHaveLength(1);
		expect(results[0].exitCode).toBe(1);
	});
});

describe("multi-agent integration: worktree isolation opt-in", () => {
	let repo: TempGitRepo;

	beforeEach(() => {
		repo = createTempGitRepo();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("runs the agent inside an isolated git worktree when opted in, merging + cleaning up after", async () => {
		const agentId = `wt-test-${randomUUID()}`;
		let observedCwd = "";
		const runner: AgentRunner = async (cwd) => {
			observedCwd = cwd;
			expect(existsSync(cwd)).toBe(true);
			expect(cwd).not.toBe(repo.repoPath);
			return { agent: "worker", task: "isolated task", exitCode: 0, output: "ok", stderr: "" };
		};

		const result = await runSingleTask(repo.repoPath, makeAgent(), "isolated task", {
			worktree: true,
			agentId,
			runner,
		});

		expect(observedCwd).toBe(join(repo.repoPath, WORKTREE_DIR_NAME, agentId));
		// Merged back and cleaned up on success: the worktree directory no longer exists.
		expect(existsSync(observedCwd)).toBe(false);
		expect(result.merge?.success).toBe(true);
		expect(result.merge?.branch).toBe(`agent/${agentId}`);
	});

	it("surfaces a failed merge-back with branch name and conflicts on the RunResult", async () => {
		const agentId = `wt-conflict-${randomUUID()}`;
		const runner: AgentRunner = async (cwd) => {
			// Diverge the base branch after the worktree was created...
			writeFileSync(join(repo.repoPath, "README.md"), "main change\n", "utf-8");
			execFileSync("git", ["add", "README.md"], { cwd: repo.repoPath });
			execFileSync("git", ["commit", "-m", "main: change readme"], { cwd: repo.repoPath });
			// ...and make a conflicting edit in the worktree.
			writeFileSync(join(cwd, "README.md"), "agent change\n", "utf-8");
			return { agent: "worker", task: "conflicting task", exitCode: 0, output: "ok", stderr: "" };
		};

		const result = await runSingleTask(repo.repoPath, makeAgent(), "conflicting task", {
			worktree: true,
			agentId,
			runner,
		});

		expect(result.merge?.success).toBe(false);
		expect(result.merge?.branch).toBe(`agent/${agentId}`);
		expect(result.merge?.conflicts).toContain("README.md");
		// The agent's work survives cleanup on its unmerged branch...
		expect(() =>
			execFileSync("git", ["rev-parse", "--verify", `agent/${agentId}`], { cwd: repo.repoPath }),
		).not.toThrow();
		// ...and the base tree is left clean (merge was aborted).
		expect(readFileSync(join(repo.repoPath, "README.md"), "utf-8")).toBe("main change\n");
	});

	it("does not report a merge outcome when cwd is not a git repo", async () => {
		const plainDir = mkdtempSync(join(tmpdir(), "subagent-non-git-"));
		try {
			const { runner } = makeFakeRunner();
			const result = await runSingleTask(plainDir, makeAgent(), "no repo here", {
				worktree: true,
				agentId: `wt-plain-${randomUUID()}`,
				runner,
			});

			expect(result.merge).toBeUndefined();
		} finally {
			rmSync(plainDir, { recursive: true, force: true });
		}
	});

	it("runs directly in cwd (no isolation) when worktree is not opted in", async () => {
		let observedCwd = "";
		const runner: AgentRunner = async (cwd) => {
			observedCwd = cwd;
			return { agent: "worker", task: "t", exitCode: 0, output: "ok", stderr: "" };
		};

		await runSingleTask(repo.repoPath, makeAgent(), "not isolated", { runner });

		expect(observedCwd).toBe(repo.repoPath);
	});
});

describe("describeMergeFailure", () => {
	const base: RunResult = { agent: "worker", task: "t", exitCode: 0, output: "ok", stderr: "" };

	it("returns undefined when no merge was attempted", () => {
		expect(describeMergeFailure(base)).toBeUndefined();
	});

	it("returns undefined when the merge-back succeeded", () => {
		expect(describeMergeFailure({ ...base, merge: { success: true, branch: "agent/x" } })).toBeUndefined();
	});

	it("names the branch, the recovery command, and the resolve-conflicts skill on failure", () => {
		const notice = describeMergeFailure({
			...base,
			merge: { success: false, branch: "agent/x", conflicts: ["a.txt"] },
		});

		expect(notice).toContain("agent/x");
		expect(notice).toContain("git merge agent/x");
		expect(notice).toContain("resolve-conflicts");
		expect(notice).toContain("a.txt");
	});
});

describe("multi-agent integration: permission gate hook point", () => {
	function makeCtx(overrides: Partial<{ hasUI: boolean; confirm: ReturnType<typeof vi.fn> }> = {}): ExtensionContext {
		const confirm = overrides.confirm ?? vi.fn().mockResolvedValue(true);
		return {
			hasUI: overrides.hasUI ?? true,
			ui: { confirm },
		} as unknown as ExtensionContext;
	}

	it("consults the permission gate before dispatch and blocks a denied tool call", async () => {
		const gate = new PermissionGate(
			parseRules(`
rules:
  - tool: bash
    pattern: "rm -rf *"
    action: deny
`),
		);
		const evaluateSpy = vi.spyOn(gate, "evaluate");
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(
			{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "rm -rf /" } } as never,
			makeCtx(),
		);

		expect(evaluateSpy).toHaveBeenCalledWith("bash", { command: "rm -rf /" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("deny");
	});

	it("consults ui.confirm for approve-tier decisions and blocks on rejection", async () => {
		const gate = new PermissionGate(
			parseRules(`
rules:
  - tool: bash
    pattern: "git push *"
    action: approve
`),
		);
		const confirm = vi.fn().mockResolvedValue(false);
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(
			{ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "git push origin main" } } as never,
			makeCtx({ confirm }),
		);

		expect(confirm).toHaveBeenCalled();
		expect(result).toEqual({ block: true, reason: "User denied approval" });
	});

	it("lets an approve-tier call through once the user confirms", async () => {
		const gate = new PermissionGate(
			parseRules(`
rules:
  - tool: bash
    pattern: "git push *"
    action: approve
`),
		);
		const confirm = vi.fn().mockResolvedValue(true);
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(
			{ type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "git push origin main" } } as never,
			makeCtx({ confirm }),
		);

		expect(confirm).toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("blocks an approve-tier call outright when no UI is available (fail-safe)", async () => {
		const gate = new PermissionGate(
			parseRules(`
rules:
  - tool: bash
    pattern: "git push *"
    action: approve
`),
		);
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(
			{ type: "tool_call", toolCallId: "4", toolName: "bash", input: { command: "git push origin main" } } as never,
			makeCtx({ hasUI: false }),
		);

		expect(result?.block).toBe(true);
	});

	it("allows a tool call with no matching rule to proceed", async () => {
		const gate = new PermissionGate([]);
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(
			{ type: "tool_call", toolCallId: "5", toolName: "read", input: { path: "src/index.ts" } } as never,
			makeCtx(),
		);

		expect(result).toBeUndefined();
	});
});
