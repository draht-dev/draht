import { describe, expect, it } from "vitest";
import type { WorkflowMeta } from "../../src/core/polyphase/workflow/meta.ts";
import {
	runWorkflowScript,
	type WorkflowAgentReply,
	type WorkflowAgentRequest,
	type WorkflowHost,
	type WorkflowRunSpec,
} from "../../src/core/polyphase/workflow/runtime.ts";

const META: WorkflowMeta = { name: "demo", description: "Demo workflow", phases: [{ title: "Only" }] };

class FakeWorkflowHost implements WorkflowHost {
	readonly calls: WorkflowAgentRequest[] = [];
	readonly logs: { text: string; level: "info" | "warning" }[] = [];
	readonly phases: string[] = [];
	spent = 0;
	private readonly handler: (request: WorkflowAgentRequest) => Promise<WorkflowAgentReply>;

	constructor(handler: (request: WorkflowAgentRequest) => Promise<WorkflowAgentReply>) {
		this.handler = handler;
	}

	async runAgent(request: WorkflowAgentRequest, _signal: AbortSignal): Promise<WorkflowAgentReply> {
		this.calls.push(request);
		return this.handler(request);
	}

	onPhase(title: string): number {
		this.phases.push(title);
		return this.phases.length - 1;
	}

	onLog(text: string, level: "info" | "warning"): void {
		this.logs.push({ text, level });
	}

	spentTokens(): number {
		return this.spent;
	}
}

class ControlledWorkflowHost implements WorkflowHost {
	readonly calls: { request: WorkflowAgentRequest; signal: AbortSignal }[] = [];
	readonly logs: { text: string; level: "info" | "warning" }[] = [];
	readonly phases: string[] = [];
	spent = 0;
	private readonly pending = new Map<string, (reply: WorkflowAgentReply) => void>();

	async runAgent(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReply> {
		this.calls.push({ request, signal });
		return new Promise<WorkflowAgentReply>((resolve) => {
			this.pending.set(request.prompt, resolve);
		});
	}

	release(prompt: string, reply: WorkflowAgentReply = { kind: "value", value: prompt }): void {
		const resolve = this.pending.get(prompt);
		if (!resolve) throw new Error(`no pending call for "${prompt}"`);
		this.pending.delete(prompt);
		resolve(reply);
	}

	onPhase(title: string): number {
		this.phases.push(title);
		return this.phases.length - 1;
	}

	onLog(text: string, level: "info" | "warning"): void {
		this.logs.push({ text, level });
	}

	spentTokens(): number {
		return this.spent;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeSpec(body: string, overrides: Partial<WorkflowRunSpec> & { host: WorkflowHost }): WorkflowRunSpec {
	return {
		meta: META,
		body,
		args: "",
		budgetTokens: null,
		maxAgents: 10,
		maxItemsPerCall: 10,
		timeoutMs: Number.POSITIVE_INFINITY,
		signal: new AbortController().signal,
		...overrides,
	};
}

describe("runWorkflowScript: agent()", () => {
	it("returns a string, an object and null, and throws on a host error reply", async () => {
		const replies: WorkflowAgentReply[] = [
			{ kind: "value", value: "hello" },
			{ kind: "value", value: { a: 1 } },
			{ kind: "null", reason: "failed" },
			{ kind: "error", message: "boom" },
		];
		let i = 0;
		const host = new FakeWorkflowHost(async () => replies[i++]);
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				const a = await agent("p1");
				const b = await agent("p2");
				const c = await agent("p3");
				try { await agent("p4"); return "no throw"; }
				catch (e) { return [a, b, c, e.message]; }
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual(["hello", { a: 1 }, null, "boom"]);
	});
});

describe("runWorkflowScript: agent() error source location", () => {
	it("reports the call site's line for an uncaught agent() error reply, not just the prelude", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "error", message: "bad model" }));
		const outcome = await runWorkflowScript(makeSpec('\nconst x = 1;\nawait agent("p");\n', { host }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe("bad model");
		expect(outcome.error.line).toBe(3);
	});

	it("converts a rejecting host.runAgent into a normal error reply, with the call site's line", async () => {
		const host = new FakeWorkflowHost(async () => {
			throw new Error("network reset");
		});
		const outcome = await runWorkflowScript(makeSpec('\nconst x = 1;\nawait agent("p");\n', { host }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe("network reset");
		expect(outcome.error.line).toBe(3);
	});
});

describe("runWorkflowScript: parallel()", () => {
	it("is a barrier and never rejects; a throwing thunk yields null and logs a warning", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "done" }));
		const outcome = await runWorkflowScript(
			makeSpec('return await parallel([() => agent("ok"), () => { throw new Error("bad"); }]);', { host }),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual(["done", null]);
		expect(host.logs).toEqual([{ text: expect.stringContaining("parallel item 1 failed: bad"), level: "warning" }]);
	});

	it("enforces maxItemsPerCall with a RangeError", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "x" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				try { await parallel(Array.from({ length: 3 }, () => () => agent("x"))); return "no throw"; }
				catch (e) { return e.message; }
				`,
				{ host, maxItemsPerCall: 2 },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toBe("parallel() accepts at most 2 items");
	});

	it("treats a non-finite maxItemsPerCall as unlimited instead of embedding JSON null", async () => {
		const host = new FakeWorkflowHost(async (request) => ({ kind: "value", value: request.prompt }));
		const outcome = await runWorkflowScript(
			makeSpec('return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);', {
				host,
				maxItemsPerCall: Number.POSITIVE_INFINITY,
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual(["a", "b", "c"]);
	});

	it("is a true barrier: it does not resolve while the slowest thunk is pending, and returns results in input order", async () => {
		const host = new ControlledWorkflowHost();
		const outcomePromise = runWorkflowScript(
			makeSpec('return await parallel([() => agent("slow"), () => agent("fast")]);', { host }),
		);
		await waitFor(() => host.calls.length >= 2);

		host.release("fast", { kind: "value", value: "fast-done" });
		let settled = false;
		void outcomePromise.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		host.release("slow", { kind: "value", value: "slow-done" });
		const outcome = await outcomePromise;
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual(["slow-done", "fast-done"]);
	});
});

describe("runWorkflowScript: pipeline()", () => {
	it("has no barrier between stages: a later stage of an early item starts before an earlier stage of a later item resolves", async () => {
		const host = new ControlledWorkflowHost();
		const outcomePromise = runWorkflowScript(
			makeSpec(
				`
				return await pipeline([0, 1, 2],
					(prev, item) => agent("s1-" + item),
					(prev, item) => agent("s2-" + item),
				);
				`,
				{ host },
			),
		);
		await waitFor(() => host.calls.length >= 3);
		expect(host.calls.map((c) => c.request.prompt).sort()).toEqual(["s1-0", "s1-1", "s1-2"]);

		host.release("s1-0");
		await waitFor(() => host.calls.some((c) => c.request.prompt === "s2-0"));
		// Items 1 and 2 are still on stage 1 while item 0 has already moved to stage 2.
		expect(host.calls.some((c) => c.request.prompt === "s1-1")).toBe(true);
		expect(host.calls.some((c) => c.request.prompt === "s2-1")).toBe(false);

		host.release("s2-0");
		host.release("s1-1");
		host.release("s1-2");
		await waitFor(
			() =>
				host.calls.some((c) => c.request.prompt === "s2-1") && host.calls.some((c) => c.request.prompt === "s2-2"),
		);
		host.release("s2-1");
		host.release("s2-2");

		const outcome = await outcomePromise;
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual(["s2-0", "s2-1", "s2-2"]);
	});

	it("gives a throwing stage's item null, skips later stages for that item, and logs a warning", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "unused" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				const seen = [];
				const result = await pipeline(["x"],
					(prev) => { throw new Error("stage1 failed"); },
					(prev) => { seen.push("stage2 ran"); return prev; },
				);
				return [result, seen];
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual([[null], []]);
		expect(host.logs).toEqual([
			{ text: expect.stringContaining("pipeline item 0 failed in stage 1: stage1 failed"), level: "warning" },
		]);
	});

	it("passes (prev, item, index) to every stage, with the item as prev for the first stage", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "unused" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				const seen = [];
				const result = await pipeline(["a", "b"],
					(prev, item, index) => { seen.push(["s1", prev, item, index]); return prev + "1"; },
					(prev, item, index) => { seen.push(["s2", prev, item, index]); return prev + "2"; },
				);
				return [result, seen];
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const [result, seen] = outcome.value as [string[], unknown[]];
		expect(result).toEqual(["a12", "b12"]);
		for (const triple of [
			["s1", "a", "a", 0],
			["s1", "b", "b", 1],
			["s2", "a1", "a", 0],
			["s2", "b1", "b", 1],
		]) {
			expect(seen).toContainEqual(triple);
		}
	});

	it("enforces maxItemsPerCall with a RangeError", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "x" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				try { await pipeline([1, 2, 3], (p) => p); return "no throw"; }
				catch (e) { return e.message; }
				`,
				{ host, maxItemsPerCall: 2 },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toBe("pipeline() accepts at most 2 items");
	});
});

describe("runWorkflowScript: phase()", () => {
	it("is captured synchronously at agent() call time, race-free inside concurrent pipeline stages", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				await pipeline(["a", "b"], async (prev, item) => {
					phase(item === "a" ? "Phase A" : "Phase B");
					return await agent(item);
				});
				return "done";
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		const byPrompt = new Map(host.calls.map((c) => [c.prompt, c.phase]));
		expect(byPrompt.get("a")).toBe("Phase A");
		expect(byPrompt.get("b")).toBe("Phase B");
	});
});

describe("runWorkflowScript: log, args, meta and budget", () => {
	it("log() joins its arguments as an info notice", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(makeSpec('log("count", 2, { ok: true }); return "done";', { host }));
		expect(outcome.ok).toBe(true);
		expect(host.logs).toContainEqual({ text: 'count 2 {"ok":true}', level: "info" });
	});

	it("exposes args verbatim and a readable meta", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec("return { args, metaName: meta.name, phaseTitle: meta.phases[0].title };", {
				host,
				args: "some args text",
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({ args: "some args text", metaName: "demo", phaseTitle: "Only" });
	});

	it("round-trips args and meta.description containing a URL (a `//` that is not a comment)", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const metaWithUrl: WorkflowMeta = {
			...META,
			description: "See https://example.com/x//y for details",
		};
		const outcome = await runWorkflowScript(
			makeSpec("return { args, description: meta.description };", {
				host,
				meta: metaWithUrl,
				args: "review https://github.com/owner/repo",
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({
			args: "review https://github.com/owner/repo",
			description: "See https://example.com/x//y for details",
		});
	});

	it("mirrors budget.spent() and budget.remaining() from the reply's spent", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		host.spent = 40;
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				await agent("p");
				return { spent: budget.spent(), remaining: budget.remaining(), total: budget.total };
				`,
				{ host, budgetTokens: 100 },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({ spent: 40, remaining: 60, total: 100 });
	});

	it("remaining() is Infinity when there is no budget", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec("return { remaining: budget.remaining() === Infinity };", { host, budgetTokens: null }),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({ remaining: true });
	});
});

describe("runWorkflowScript: caps", () => {
	it("rejects the (maxAgents + 1)th accepted agent() call", async () => {
		const host = new FakeWorkflowHost(async (request) => ({ kind: "value", value: request.prompt }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				const a = await agent("a");
				const b = await agent("b");
				let err;
				try { await agent("c"); } catch (e) { err = e.message; }
				return { a, b, err };
				`,
				{ host, maxAgents: 2 },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({
			a: "a",
			b: "b",
			err: "agent cap reached: a workflow may start at most 2 agents (polyphase.maxAgentsPerRun)",
		});
		expect(outcome.agentCalls).toBe(2);
	});

	it("rejects an agent() request with a label over 80 characters", async () => {
		const host = new FakeWorkflowHost(async (request) => ({ kind: "value", value: request.prompt }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				try { await agent("p", { label: "x".repeat(81) }); return "no throw"; }
				catch (e) { return e.message; }
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toBe("agent(): label must be a string of at most 80 characters");
		expect(host.calls).toEqual([]);
	});

	it('rejects an agent() request with an isolation other than "worktree"', async () => {
		const host = new FakeWorkflowHost(async (request) => ({ kind: "value", value: request.prompt }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				try { await agent("p", { isolation: "x" }); return "no throw"; }
				catch (e) { return e.message; }
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toBe('agent(): isolation must be "worktree"');
		expect(host.calls).toEqual([]);
	});

	it("rejects a phase(title) call over 80 characters at the call site", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				try { phase("x".repeat(81)); return "no throw"; }
				catch (e) { return e.message; }
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toBe("phase(title) needs a non-empty string of at most 80 characters");
		expect(host.phases).toEqual([]);
	});
});

describe("runWorkflowScript: determinism", () => {
	it("Math.random, Date.now, Date() and new Date() throw, but new Date(0).toISOString() works", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
				const errs = [];
				try { Math.random(); } catch (e) { errs.push(e.message); }
				try { Date.now(); } catch (e) { errs.push(e.message); }
				try { Date(); } catch (e) { errs.push(e.message); }
				try { new Date(); } catch (e) { errs.push(e.message); }
				try { new Date(0).constructor(); } catch (e) { errs.push(e.message); }
				try { performance.now(); } catch (e) { errs.push(e.message); }
				return { errs, iso: new Date(0).toISOString() };
				`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({
			errs: [
				"Math.random is not available in workflow scripts: runs must be deterministic",
				"Date.now is not available in workflow scripts: runs must be deterministic",
				"Date() is not available in workflow scripts: runs must be deterministic",
				"new Date() is not available in workflow scripts: runs must be deterministic",
				"Date() is not available in workflow scripts: runs must be deterministic",
				"performance.now is not available in workflow scripts: runs must be deterministic",
			],
			iso: "1970-01-01T00:00:00.000Z",
		});
	});
});

describe("runWorkflowScript: cancellation", () => {
	it("aborting spec.signal gives kind aborted and aborts the in-flight host signal", async () => {
		const host = new ControlledWorkflowHost();
		const controller = new AbortController();
		const outcomePromise = runWorkflowScript(
			makeSpec('await agent("hang"); return "never";', { host, signal: controller.signal }),
		);
		await waitFor(() => host.calls.length >= 1);
		controller.abort(new Error("stop"));
		const outcome = await outcomePromise;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.kind).toBe("aborted");
		expect(host.calls[0].signal.aborted).toBe(true);
	});

	it("aborts an un-awaited agent's signal when the script returns", async () => {
		const host = new ControlledWorkflowHost();
		const outcome = await runWorkflowScript(makeSpec('agent("fire-and-forget"); return "done";', { host }));
		expect(outcome.ok).toBe(true);
		await waitFor(() => host.calls.length >= 1);
		await waitFor(() => host.calls[0].signal.aborted);
	});

	it("gives kind timeout when the deadline expires", async () => {
		const host = new ControlledWorkflowHost();
		const outcome = await runWorkflowScript(
			makeSpec('await agent("hang"); return "never";', { host, timeoutMs: 200 }),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.kind).toBe("timeout");
	});
});

describe("runWorkflowScript: script errors", () => {
	it("reports the thrown error's source line, matching the body as written", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
const x = 1;
throw new Error("boom on line 3");
`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.line).toBe(3);
		expect(outcome.error.message).toBe("boom on line 3");
	});

	it("reports a source column on body line 1, not the raw codemode.js column past the prelude", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(makeSpec('throw new Error("boom on line 1");', { host }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.line).toBe(1);
		expect(outcome.error.column).toBe(11);
	});

	it("collects console.log output in consoleOutput", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(makeSpec('console.log("from the script"); return "done";', { host }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.consoleOutput).toContain("from the script");
	});

	it("is not confused by a message that itself looks like a codemode.js frame", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(
			makeSpec(
				`
const x = 1;
throw new Error("see codemode.js:99:99 for details");
`,
				{ host },
			),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.line).toBe(3);
	});

	it("gives a redeclaration hint for a SyntaxError that shadows a prelude name", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(makeSpec("const agent = 2; return agent;", { host }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.kind).toBe("script");
		expect(outcome.error.hint).toBe("do not redeclare agent, parallel, pipeline, phase, log, args, budget or meta");
	});

	it("round-trips the script's return value", async () => {
		const host = new FakeWorkflowHost(async () => ({ kind: "value", value: "ok" }));
		const outcome = await runWorkflowScript(makeSpec("return { a: 1, b: [true, null, 'x'] };", { host }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toEqual({ a: 1, b: [true, null, "x"] });
	});
});
