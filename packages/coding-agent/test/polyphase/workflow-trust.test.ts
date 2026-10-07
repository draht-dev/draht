import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { hasTrustRequiringProjectResources } from "../../src/core/trust-manager.ts";

describe("hasTrustRequiringProjectResources with .draht/workflows", () => {
	let root: string;

	beforeEach(() => {
		root = realpathSync(
			(() => {
				const dir = join(tmpdir(), `workflow-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
				mkdirSync(dir, { recursive: true });
				return dir;
			})(),
		);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("is true for a project containing only .draht/workflows/x.js", () => {
		const workflowsDir = join(root, CONFIG_DIR_NAME, "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		writeFileSync(
			join(workflowsDir, "x.js"),
			"export const meta = { name: 'x', description: 'd', phases: [{title:'t'}] };",
		);

		expect(hasTrustRequiringProjectResources(root)).toBe(true);
	});

	it("is true for a subdirectory of that project", () => {
		const workflowsDir = join(root, CONFIG_DIR_NAME, "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		writeFileSync(
			join(workflowsDir, "x.js"),
			"export const meta = { name: 'x', description: 'd', phases: [{title:'t'}] };",
		);

		const sub = join(root, "nested", "deeper");
		mkdirSync(sub, { recursive: true });

		expect(hasTrustRequiringProjectResources(sub)).toBe(true);
	});

	it("is false for a project with no trust-requiring resources", () => {
		const sub = join(root, "nested");
		mkdirSync(sub, { recursive: true });

		// This temp tree controls only `sub` and its ancestors up to `root`; an ancestor of
		// `root` itself (e.g. a dev machine's $HOME or /tmp) may legitimately carry its own
		// .draht/agents, .draht/workflows or .agents/skills, which would make this assertion
		// flake independent of anything this test wrote. Skip rather than assert a host fact.
		if (hasTrustRequiringProjectResources(root)) return;

		expect(hasTrustRequiringProjectResources(sub)).toBe(false);
	});
});
