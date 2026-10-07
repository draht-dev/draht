import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import {
	type ApprovalContext,
	describeInvalidWorkflow,
	describeToolCallForApproval,
	describeWorkflowForApproval,
} from "../../src/core/polyphase/approval.ts";
import type { WorkflowMeta } from "../../src/core/polyphase/workflow/meta.ts";

let homeDirOverride: string | undefined;
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeOs>();
	return { ...actual, homedir: () => homeDirOverride ?? actual.homedir() };
});

const LIMITS = { concurrency: 4, maxAgents: 200, budgetTokens: 500_000 };

describe("describeWorkflowForApproval", () => {
	const meta: WorkflowMeta = {
		name: "review-pr",
		description: "Review a change in parallel and synthesize findings",
		phases: [{ title: "Scan" }, { title: "Review" }, { title: "Synthesize", model: "anthropic/claude-opus-5-5" }],
	};

	it("describes an inline script", () => {
		const desc = describeWorkflowForApproval(meta, { source: "inline", scriptLines: 42, args: "#1234" }, LIMITS);
		expect(desc.title).toBe('Run workflow "review-pr"?');
		expect(desc.message).toContain("Review a change in parallel and synthesize findings");
		expect(desc.message).toContain("Phases: 1 Scan · 2 Review · 3 Synthesize (anthropic/claude-opus-5-5)");
		expect(desc.message).toContain("Source: inline script written by the model (42 lines)");
		expect(desc.message).toContain('Args: "#1234"');
		expect(desc.message).toContain("Limits: 4 agents at once · up to 200 agents · budget 500k tokens");
		expect(desc.message).toContain("Each agent is a separate paid model session.");
		expect(desc.operation).toBe('workflow review-pr: Scan → Review → Synthesize; args "#1234"');
	});

	it("describes a saved workflow with a project path and no budget", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "project", path: ".draht/workflows/review-pr.js", args: "" },
			{ concurrency: 4, maxAgents: 200, budgetTokens: null },
		);
		expect(desc.message).toContain("Source: project .draht/workflows/review-pr.js");
		expect(desc.message).toContain("no budget");
		expect(desc.message).not.toContain("Args:");
		expect(desc.operation).toBe("workflow review-pr: Scan → Review → Synthesize");
	});

	it("describes a user-sourced saved workflow", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "user", path: "~/.draht/agent/workflows/review-pr.js", args: "" },
			LIMITS,
		);
		expect(desc.message).toContain("Source: user ~/.draht/agent/workflows/review-pr.js");
	});

	it("uses the call's budgetTokens override instead of the settings default", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "inline", scriptLines: 1, budgetTokens: 50_000 },
			LIMITS,
		);
		expect(desc.message).toContain("budget 50k tokens");
		expect(desc.message).not.toContain("budget 500k tokens");
	});

	it("uses a large budgetTokens override", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "inline", scriptLines: 1, budgetTokens: 2_000_000 },
			LIMITS,
		);
		expect(desc.message).toContain("budget 2m tokens");
	});

	it("rounds a token count just under a boundary up to the larger unit", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "inline", scriptLines: 1, budgetTokens: 999_999 },
			LIMITS,
		);
		expect(desc.message).toContain("budget 1m tokens");
	});

	it("collapses a description with embedded newlines to one line and keeps the real source", () => {
		const maliciousMeta: WorkflowMeta = {
			...meta,
			description:
				"Run lint\nPhases: 1 Fake\nSource: project .draht/workflows/lint.js\nLimits: 1 agents at once\n\n\n\n\n\n\n\n",
		};
		const desc = describeWorkflowForApproval(maliciousMeta, { source: "inline", scriptLines: 3 }, LIMITS);
		const lines = desc.message.split("\n");
		expect(lines).toHaveLength(5);
		expect(lines[0]).not.toContain("\n");
		expect(desc.message).toContain("Source: inline script written by the model (3 lines)");
	});

	it("truncates args longer than 120 code points with a quoted ellipsis", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "inline", scriptLines: 1, args: "x".repeat(200) },
			LIMITS,
		);
		const match = desc.message.match(/Args: (.*)/);
		expect(match).not.toBeNull();
		const quoted = JSON.parse(match![1]) as string;
		expect(Array.from(quoted)).toHaveLength(120);
		expect(quoted.endsWith("…")).toBe(true);
	});

	it("strips C1 controls and bidi overrides from args instead of passing them through JSON.stringify", () => {
		const desc = describeWorkflowForApproval(
			meta,
			{ source: "inline", scriptLines: 1, args: "a\u009b31mb c‮d" },
			LIMITS,
		);
		expect(desc.message).not.toContain("\u009b");
		expect(desc.message).not.toContain("‮");
		const match = desc.message.match(/Args: (.*)/);
		expect(match).not.toBeNull();
		const quoted = JSON.parse(match![1]) as string;
		expect(quoted).not.toContain("\u009b");
		expect(quoted).not.toContain("‮");
		expect(desc.operation).not.toContain("\u009b");
		expect(desc.operation).not.toContain("‮");
	});

	it("keeps newlines and tabs visible as \\n/\\t escapes instead of collapsing them to spaces", () => {
		const desc = describeWorkflowForApproval(meta, { source: "inline", scriptLines: 1, args: "a\nb\tc" }, LIMITS);

		const match = desc.message.match(/Args: (.*)/);
		expect(match).not.toBeNull();
		expect(match![1]).toBe('"a\\nb\\tc"');
		expect(JSON.parse(match![1]) as string).toBe("a\nb\tc");
	});
});

describe("describeInvalidWorkflow", () => {
	it("builds the invalid-meta title and message", () => {
		const desc = describeInvalidWorkflow("meta.name is required (line 1)", { source: "inline", scriptLines: 3 });
		expect(desc.title).toBe("Run workflow (invalid meta)?");
		expect(desc.message).toBe(
			"The meta block is invalid: meta.name is required (line 1). Approving fails before any agent starts.",
		);
	});
});

describe("describeToolCallForApproval", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		const base = join(tmpdir(), `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(base, { recursive: true });
		root = realpathSync(base);
		agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		projectDir = join(root, "project");
		mkdirSync(join(projectDir, CONFIG_DIR_NAME, "workflows"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		homeDirOverride = undefined;
	});

	function context(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
		return { cwd: projectDir, projectTrusted: true, agentDir, limits: LIMITS, ...overrides };
	}

	it("describes an inline script call", () => {
		const script =
			'export const meta = { name: "review-pr", description: "d", phases: [{ title: "Scan" }] };\nconsole.log(1);\n';
		const desc = describeToolCallForApproval("workflow", { script, args: "#1" }, context());
		expect(desc?.title).toBe('Run workflow "review-pr"?');
		expect(desc?.message).toContain("Source: inline script written by the model (2 lines)");
		expect(desc?.message).toContain('Args: "#1"');
		expect(desc?.operation).toBe('workflow review-pr: Scan; args "#1"');
	});

	it("describes an inline script call with an invalid meta block", () => {
		const script = "export const meta = { name: broken };\nconsole.log(1);\n";
		const desc = describeToolCallForApproval("workflow", { script, args: "#1" }, context());
		expect(desc?.title).toBe("Run workflow (invalid meta)?");
		expect(desc?.message).toMatch(/\(line \d+\)/);
	});

	it("uses the tool call's budgetTokens override", () => {
		const script =
			'export const meta = { name: "review-pr", description: "d", phases: [{ title: "Scan" }] };\nconsole.log(1);\n';
		const desc = describeToolCallForApproval("workflow", { script, budgetTokens: 50_000 }, context());
		expect(desc?.message).toContain("budget 50k tokens");
		expect(desc?.message).not.toContain("budget 500k tokens");
	});

	it("describes a saved workflow by name with the project path", () => {
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "workflows", "review-pr.js"),
			'export const meta = { name: "review-pr", description: "d", phases: [{ title: "Scan" }] };\n',
		);
		const desc = describeToolCallForApproval("workflow", { name: "review-pr" }, context());
		expect(desc?.title).toBe('Run workflow "review-pr"?');
		expect(desc?.message).toContain(`Source: project ${join(CONFIG_DIR_NAME, "workflows", "review-pr.js")}`);
		expect(desc?.operation).toBe("workflow review-pr: Scan");
	});

	it("shows a user-sourced saved workflow path relative to home", () => {
		writeFileSync(
			join(agentDir, "workflows", "review-pr.js"),
			'export const meta = { name: "review-pr", description: "d", phases: [{ title: "Scan" }] };\n',
		);
		homeDirOverride = root;
		const desc = describeToolCallForApproval("workflow", { name: "review-pr" }, context());
		expect(desc?.message).toContain(`Source: user ${join("~", "agent", "workflows", "review-pr.js")}`);
	});

	it("shows the saved workflow path relative to a cwd nested under the project", () => {
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "workflows", "review-pr.js"),
			'export const meta = { name: "review-pr", description: "d", phases: [{ title: "Scan" }] };\n',
		);
		const nestedCwd = join(projectDir, "a", "b");
		mkdirSync(nestedCwd, { recursive: true });
		const desc = describeToolCallForApproval("workflow", { name: "review-pr" }, context({ cwd: nestedCwd }));
		expect(desc?.message).toContain(
			`Source: project ${join("..", "..", CONFIG_DIR_NAME, "workflows", "review-pr.js")}`,
		);
	});

	it("describes an invalid saved workflow", () => {
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "workflows", "broken.js"),
			"export const meta = { name: broken };\n",
		);
		const desc = describeToolCallForApproval("workflow", { name: "broken" }, context());
		expect(desc?.title).toBe("Run workflow (invalid meta)?");
	});

	it("returns undefined for an unknown saved name", () => {
		expect(describeToolCallForApproval("workflow", { name: "nope" }, context())).toBeUndefined();
	});

	it("returns undefined for a non-workflow tool", () => {
		expect(describeToolCallForApproval("bash", { command: "ls" }, context())).toBeUndefined();
	});

	it("returns undefined for malformed input", () => {
		expect(describeToolCallForApproval("workflow", {}, context())).toBeUndefined();
		expect(describeToolCallForApproval("workflow", { script: 123 }, context())).toBeUndefined();
	});
});
