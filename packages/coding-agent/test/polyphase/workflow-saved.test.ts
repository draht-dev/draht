import { execFileSync } from "node:child_process";
import type * as NodeFs from "node:fs";
import type { Stats } from "node:fs";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import {
	discoverSavedWorkflows,
	findSavedWorkflow,
	readSavedWorkflowSource,
	SAVED_WORKFLOW_MAX_BYTES,
	type SavedDiscoveryOptions,
} from "../../src/core/polyphase/workflow/saved.ts";

// `vi.spyOn("node:fs", ...)` can't redefine a frozen ESM namespace export; wrapping
// `lstatSync`/`readdirSync` in a mock module (defaulting to the real implementations) is the
// seam the TOCTOU and "no full discovery pass" tests below need instead.
const fsMocks = vi.hoisted(() => ({ lstatSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof NodeFs>("node:fs");
	fsMocks.lstatSync.mockImplementation(actual.lstatSync);
	fsMocks.readdirSync.mockImplementation(actual.readdirSync);
	return { ...actual, lstatSync: fsMocks.lstatSync, readdirSync: fsMocks.readdirSync };
});

function validScript(name: string, description = "does things"): string {
	return `export const meta = { name: "${name}", description: "${description}", phases: [{ title: "Only phase" }] };\nconsole.log("ok");\n`;
}

describe("discoverSavedWorkflows", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let nestedCwd: string;

	beforeEach(() => {
		const base = join(tmpdir(), `saved-workflows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(base, { recursive: true });
		root = realpathSync(base);
		agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		projectDir = join(root, "project");
		nestedCwd = join(projectDir, "a", "b");
		mkdirSync(nestedCwd, { recursive: true });
		// Stops findProjectWorkflowsDir's upward walk at projectDir. Without this, a test that
		// doesn't write a project workflow leaves no `.draht/workflows` under projectDir, and the
		// walk continues past this temp tree to whatever ancestor of the OS tmp dir the host
		// happens to have (e.g. a dev machine's $HOME), making results depend on the host.
		mkdirSync(join(projectDir, CONFIG_DIR_NAME, "workflows"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function options(overrides: Partial<SavedDiscoveryOptions> = {}): SavedDiscoveryOptions {
		return { cwd: nestedCwd, agentDir, projectTrusted: true, ...overrides };
	}

	function writeUserWorkflow(filename: string, content: string): void {
		writeFileSync(join(agentDir, "workflows", filename), content);
	}

	function writeProjectWorkflow(filename: string, content: string): void {
		const dir = join(projectDir, CONFIG_DIR_NAME, "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, filename), content);
	}

	it("lists a user workflow", () => {
		writeUserWorkflow("review.js", validScript("review"));
		const { workflows } = discoverSavedWorkflows(options());
		expect(workflows).toHaveLength(1);
		expect(workflows[0]).toMatchObject({ name: "review", source: "user", valid: true });
	});

	it("project overrides user with the same name, with an info diagnostic", () => {
		writeUserWorkflow("review.js", validScript("review", "user version"));
		writeProjectWorkflow("review.js", validScript("review", "project version"));

		const { workflows, diagnostics } = discoverSavedWorkflows(options());
		expect(workflows).toHaveLength(1);
		expect(workflows[0]).toMatchObject({ name: "review", source: "project", description: "project version" });
		expect(diagnostics.some((d) => d.level === "info" && d.message.includes("overrides"))).toBe(true);
	});

	it("ignores an untrusted project", () => {
		writeProjectWorkflow("review.js", validScript("review"));
		const { workflows } = discoverSavedWorkflows(options({ projectTrusted: false }));
		expect(workflows).toHaveLength(0);
	});

	it("lists an invalid meta with valid false and a diagnostic", () => {
		writeUserWorkflow("broken.js", "export const meta = { name: broken };\n");
		const { workflows, diagnostics } = discoverSavedWorkflows(options());
		expect(workflows).toHaveLength(1);
		expect(workflows[0].valid).toBe(false);
		expect(workflows[0].error).toBeDefined();
		expect(diagnostics.some((d) => d.level === "warning" && d.message.includes("invalid meta block"))).toBe(true);
	});

	it("skips a file whose basename does not match the name pattern, with a warning", () => {
		writeUserWorkflow("Not_Valid.js", validScript("review"));
		const { workflows, diagnostics } = discoverSavedWorkflows(options());
		expect(workflows).toHaveLength(0);
		expect(diagnostics.some((d) => d.level === "warning" && d.message.includes("Not_Valid.js"))).toBe(true);
	});

	it("emits an info diagnostic when meta.name does not match the basename", () => {
		writeUserWorkflow("mismatch.js", validScript("other-name"));
		const { workflows, diagnostics } = discoverSavedWorkflows(options());
		expect(workflows).toHaveLength(1);
		expect(workflows[0].name).toBe("mismatch");
		expect(diagnostics.some((d) => d.level === "info" && d.message.includes("mismatch"))).toBe(true);
	});

	it("accepts a symlinked file", () => {
		const targetPath = join(agentDir, "workflows", "target.js");
		writeFileSync(targetPath, validScript("linked"));
		symlinkSync(targetPath, join(agentDir, "workflows", "linked.js"));

		const { workflows } = discoverSavedWorkflows(options());
		const names = workflows.map((w) => w.name);
		expect(names).toContain("linked");
	});

	it("skips a file over 256 KiB, with a warning", () => {
		const big = `${"x".repeat(SAVED_WORKFLOW_MAX_BYTES + 1)}`;
		writeUserWorkflow(
			"huge.js",
			`// ${big}\nexport const meta = ${JSON.stringify({ name: "huge", description: "d", phases: [{ title: "t" }] })};`,
		);
		const { workflows, diagnostics } = discoverSavedWorkflows(options());
		expect(workflows.find((w) => w.name === "huge")).toBeUndefined();
		expect(
			diagnostics.some(
				(d) => d.level === "warning" && d.message.includes("huge.js") && d.message.includes("exceeds"),
			),
		).toBe(true);
	});

	it("findSavedWorkflow finds a workflow by name, valid or not", () => {
		writeUserWorkflow("review.js", validScript("review"));
		writeUserWorkflow("broken.js", "export const meta = { name: broken };\n");

		expect(findSavedWorkflow("review", options())?.valid).toBe(true);
		expect(findSavedWorkflow("broken", options())?.valid).toBe(false);
		expect(findSavedWorkflow("nope", options())).toBeUndefined();
	});

	it("findSavedWorkflow prefers the project workflow over a user workflow of the same name, without a full discovery pass", () => {
		writeUserWorkflow("review.js", validScript("review", "user version"));
		writeProjectWorkflow("review.js", validScript("review", "project version"));
		// A file whose basename fails WORKFLOW_NAME_PATTERN would make discoverSavedWorkflows
		// skip it with a diagnostic. findSavedWorkflow must not list-and-filter that way: it
		// looks up "<name>.js" directly, so a sibling that fails the pattern can't affect it.
		writeUserWorkflow("Not_Valid.js", validScript("review"));

		// "No full discovery pass" means no directory scan: discovery's defining fs call is
		// readdirSync per directory, which findSavedWorkflow's direct path lookup never makes.
		fsMocks.readdirSync.mockClear();
		const found = findSavedWorkflow("review", options());
		expect(found).toMatchObject({ source: "project", description: "project version" });
		expect(fsMocks.readdirSync).not.toHaveBeenCalled();
	});

	it("findSavedWorkflow returns undefined for a name that fails WORKFLOW_NAME_PATTERN without touching the filesystem", () => {
		fsMocks.lstatSync.mockClear();
		expect(findSavedWorkflow("Not_Valid", options())).toBeUndefined();
		expect(findSavedWorkflow("../etc/passwd", options())).toBeUndefined();
		expect(fsMocks.lstatSync).not.toHaveBeenCalled();
	});

	it("readSavedWorkflowSource returns the file content", () => {
		const content = validScript("review");
		writeUserWorkflow("review.js", content);
		const workflow = findSavedWorkflow("review", options());
		expect(workflow).toBeDefined();
		expect(readSavedWorkflowSource(workflow!)).toBe(content);
	});

	it("readSavedWorkflowSource throws for a missing file", () => {
		writeUserWorkflow("review.js", validScript("review"));
		const workflow = findSavedWorkflow("review", options());
		expect(workflow).toBeDefined();
		rmSync(workflow!.path);
		expect(() => readSavedWorkflowSource(workflow!)).toThrow();
	});

	it("readSavedWorkflowSource throws when the file grew past the limit since discovery", () => {
		writeUserWorkflow("review.js", validScript("review"));
		const workflow = findSavedWorkflow("review", options());
		expect(workflow).toBeDefined();
		writeFileSync(workflow!.path, "x".repeat(SAVED_WORKFLOW_MAX_BYTES + 1));
		expect(() => readSavedWorkflowSource(workflow!)).toThrow(/too large/);
	});

	it("does not misreport a file that grew by a few bytes since the caller's stat as too large", () => {
		const original = validScript("review");
		writeUserWorkflow("review.js", original);
		const workflow = findSavedWorkflow("review", options());
		expect(workflow).toBeDefined();
		const grown = `${original}// a few more bytes appended after the caller's stat\n`;
		writeFileSync(workflow!.path, grown);

		// Simulate the TOCTOU window itself: report the pre-growth size, as if the file grew
		// between readSavedWorkflowSource's own stat and readBoundedUtf8's read, while the file
		// on disk is already the grown (but still well under SAVED_WORKFLOW_MAX_BYTES) content.
		const staleSize = original.length;
		fsMocks.lstatSync.mockImplementationOnce(
			() => ({ isSymbolicLink: () => false, isFile: () => true, size: staleSize }) as Stats,
		);

		expect(readSavedWorkflowSource(workflow!)).toBe(grown);
	});

	it.skipIf(process.platform === "win32")(
		"readSavedWorkflowSource rejects a fifo even when the preceding stat is stale (TOCTOU)",
		() => {
			writeUserWorkflow("review.js", validScript("review"));
			const workflow = findSavedWorkflow("review", options())!;
			rmSync(workflow.path);
			execFileSync("mkfifo", [workflow.path]);

			// A stat that still reports "regular file", as if the fifo swap happened after the
			// caller's own stat but before readBoundedUtf8's fd-level check. fstatSync on the
			// actually-opened fd is not mocked, so the real check must still catch it.
			fsMocks.lstatSync.mockImplementationOnce(
				() => ({ isSymbolicLink: () => false, isFile: () => true, size: 10 }) as Stats,
			);

			expect(() => readSavedWorkflowSource(workflow)).toThrow(/no longer a regular file/);
		},
	);

	it.skipIf(process.platform === "win32")(
		"readSavedWorkflowSource throws instead of hanging when the file was replaced by a fifo",
		() => {
			writeUserWorkflow("review.js", validScript("review"));
			const workflow = findSavedWorkflow("review", options());
			expect(workflow).toBeDefined();
			rmSync(workflow!.path);
			execFileSync("mkfifo", [workflow!.path]);
			expect(() => readSavedWorkflowSource(workflow!)).toThrow(/no longer a regular file/);
		},
	);
});
