import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRules,
	PermissionGate,
	type PermissionRule,
	parseRules,
} from "../../src/core/multi-agent/permission-gate.ts";

describe("parseRules", () => {
	it("parses YAML rules from a string", () => {
		const yaml = `
rules:
  - tool: bash
    pattern: "rm -rf *"
    action: deny
  - tool: bash
    pattern: "git push *"
    action: approve
  - tool: read
    action: allow
  - tool: write
    paths: ["src/**"]
    action: allow
  - tool: write
    action: approve
`;
		const rules = parseRules(yaml);
		expect(rules).toEqual<PermissionRule[]>([
			{ tool: "bash", pattern: "rm -rf *", action: "deny" },
			{ tool: "bash", pattern: "git push *", action: "approve" },
			{ tool: "read", action: "allow" },
			{ tool: "write", paths: ["src/**"], action: "allow" },
			{ tool: "write", action: "approve" },
		]);
	});

	it("returns an empty array for empty or rule-less YAML", () => {
		expect(parseRules("")).toEqual([]);
		expect(parseRules("foo: bar\n")).toEqual([]);
	});

	it("throws on malformed rules", () => {
		expect(() => parseRules("rules:\n  - tool: bash\n")).toThrow();
		expect(() => parseRules("rules:\n  - tool: bash\n    action: yolo\n")).toThrow();
		expect(() => parseRules("rules: not-an-array\n")).toThrow();
	});
});

describe("PermissionGate.evaluate", () => {
	it("blocks tool calls matched by a deny rule, returning a reason", () => {
		const gate = new PermissionGate([{ tool: "bash", pattern: "rm -rf *", action: "deny" }]);
		const decision = gate.evaluate("bash", { command: "rm -rf /tmp/build" });
		expect(decision.action).toBe("deny");
		expect(decision.reason).toBeTruthy();
	});

	it("permits tool calls matched by an allow rule", () => {
		const gate = new PermissionGate([{ tool: "read", action: "allow" }]);
		const decision = gate.evaluate("read", { path: "README.md" });
		expect(decision.action).toBe("allow");
	});

	it("requires confirmation for tool calls matched by an approve rule", () => {
		const gate = new PermissionGate([{ tool: "bash", pattern: "git push *", action: "approve" }]);
		const decision = gate.evaluate("bash", { command: "git push origin main" });
		expect(decision.action).toBe("approve");
	});

	it("evaluates rules top-to-bottom, first match wins", () => {
		const gate = new PermissionGate([
			{ tool: "bash", pattern: "git push *", action: "deny" },
			{ tool: "bash", pattern: "git push *", action: "allow" },
		]);
		const decision = gate.evaluate("bash", { command: "git push origin main" });
		expect(decision.action).toBe("deny");
	});

	it("matches bash command patterns using glob semantics, including across path separators", () => {
		const gate = new PermissionGate([{ tool: "bash", pattern: "rm -rf *", action: "deny" }]);
		expect(gate.evaluate("bash", { command: "rm -rf /" }).action).toBe("deny");
		expect(gate.evaluate("bash", { command: "rm -rf /tmp/foo/bar" }).action).toBe("deny");
		expect(gate.evaluate("bash", { command: "ls -la" }).action).toBe("approve"); // falls through to default
	});

	describe("adversarial bash deny-rule evasion", () => {
		const gate = new PermissionGate([{ tool: "bash", pattern: "rm -rf *", action: "deny" }]);

		it("still denies when the command is invoked via an absolute path", () => {
			expect(gate.evaluate("bash", { command: "/bin/rm -rf /tmp/foo" }).action).toBe("deny");
		});

		it("still denies when prefixed with sudo/env", () => {
			expect(gate.evaluate("bash", { command: "sudo rm -rf /" }).action).toBe("deny");
			expect(gate.evaluate("bash", { command: "env rm -rf /" }).action).toBe("deny");
		});

		it("still denies when chained after an unrelated command", () => {
			expect(gate.evaluate("bash", { command: "true; rm -rf /" }).action).toBe("deny");
			expect(gate.evaluate("bash", { command: "echo hi && rm -rf /" }).action).toBe("deny");
		});

		it("still denies when wrapped in a bash -c subshell", () => {
			expect(gate.evaluate("bash", { command: 'bash -c "rm -rf /"' }).action).toBe("deny");
		});

		it("still denies with double-spacing between tokens", () => {
			expect(gate.evaluate("bash", { command: "rm  -rf  /tmp/foo" }).action).toBe("deny");
		});

		it("still denies with combined flags reordered", () => {
			expect(gate.evaluate("bash", { command: "rm -fr /tmp/foo" }).action).toBe("deny");
		});

		it("still denies regardless of case", () => {
			expect(gate.evaluate("bash", { command: "RM -RF /" }).action).toBe("deny");
		});

		it("still denies when embedded in a command substitution", () => {
			expect(gate.evaluate("bash", { command: "echo $(rm -rf /)" }).action).toBe("deny");
		});
	});

	it("does not reassemble unrelated path segments across '/' into a false match", () => {
		// A previous implementation stripped every "/" from both command and pattern before matching,
		// which could reassemble unrelated path segments into a spurious match (e.g. "/et/cpasswd"
		// colliding with a pattern scoped to "/etc/*").
		const gate = new PermissionGate([
			{ tool: "bash", pattern: "rm -rf /etc/*", action: "deny" },
			{ tool: "bash", pattern: "*", action: "approve" },
		]);
		expect(gate.evaluate("bash", { command: "rm -rf /etc/passwd" }).action).toBe("deny");
		expect(gate.evaluate("bash", { command: "rm -rf /etcetera/foo" }).action).toBe("approve");
		expect(gate.evaluate("bash", { command: "rm -rf /et/cpasswd" }).action).toBe("approve");
	});

	describe("adversarial bash allow/approve-rule injection", () => {
		it("does not let a trailing-wildcard allow rule authorize a chained/injected command", () => {
			const gate = new PermissionGate([
				{ tool: "bash", pattern: "npm test*", action: "allow" },
				{ tool: "bash", pattern: "*", action: "approve" },
			]);
			expect(gate.evaluate("bash", { command: "npm test" }).action).toBe("allow");
			// Chained, substituted, or backgrounded commands must NOT ride along on the allow rule.
			expect(gate.evaluate("bash", { command: "npm test; rm -rf /" }).action).toBe("approve");
			expect(gate.evaluate("bash", { command: "npm test && rm -rf /" }).action).toBe("approve");
			expect(gate.evaluate("bash", { command: "npm test | rm -rf /" }).action).toBe("approve");
			expect(gate.evaluate("bash", { command: "npm test `rm -rf /`" }).action).toBe("approve");
			expect(gate.evaluate("bash", { command: "npm test $(rm -rf /)" }).action).toBe("approve");
			expect(gate.evaluate("bash", { command: "npm test > /etc/passwd" }).action).toBe("approve");
		});

		it("does not let a slash-scoped allow pattern widen to an unrelated sibling command", () => {
			const gate = new PermissionGate([
				{ tool: "bash", pattern: "git push origin/*", action: "allow" },
				{ tool: "bash", pattern: "*", action: "approve" },
			]);
			expect(gate.evaluate("bash", { command: "git push origin/main" }).action).toBe("allow");
			expect(gate.evaluate("bash", { command: "git push origin-evil" }).action).toBe("approve");
		});

		it("documents that pattern-based scoping cannot detect real path traversal (use `paths` instead)", () => {
			// KNOWN LIMITATION: this is textual glob matching, not path resolution — `..` inside the
			// wildcard portion of the pattern is just more matched characters. Rules that need real
			// directory containment must use `paths`, not `pattern`.
			const gate = new PermissionGate([{ tool: "bash", pattern: "cat /safe/dir/*", action: "allow" }]);
			expect(gate.evaluate("bash", { command: "cat /safe/dir/../../../etc/passwd" }).action).toBe("allow");
		});
	});

	it("matches file paths using glob semantics for read/write/edit tools", () => {
		const gate = new PermissionGate([
			{ tool: "write", paths: ["src/**"], action: "allow" },
			{ tool: "write", action: "approve" },
		]);
		expect(gate.evaluate("write", { path: "src/core/foo.ts" }).action).toBe("allow");
		expect(gate.evaluate("write", { path: "docs/readme.md" }).action).toBe("approve");
	});

	it("matches path rules relative to the configured cwd, not the process cwd", () => {
		const gate = new PermissionGate(
			[
				{ tool: "write", paths: ["src/**"], action: "allow" },
				{ tool: "write", action: "approve" },
			],
			{ cwd: "/project" },
		);
		expect(gate.evaluate("write", { path: "/project/src/index.ts" }).action).toBe("allow");
		expect(gate.evaluate("write", { path: "/project/docs/readme.md" }).action).toBe("approve");
	});

	it("defaults bash to approve and read/edit/write to allow within the project when no rule matches", () => {
		const cwd = "/repo";
		const gate = new PermissionGate([], { cwd });
		expect(gate.evaluate("bash", { command: "echo hi" }).action).toBe("approve");
		expect(gate.evaluate("read", { path: "src/index.ts" }).action).toBe("allow");
		expect(gate.evaluate("write", { path: "src/index.ts" }).action).toBe("allow");
		expect(gate.evaluate("edit", { path: "src/index.ts" }).action).toBe("allow");
	});

	it("defaults to approve for read/edit/write paths outside the project", () => {
		const cwd = "/repo";
		const gate = new PermissionGate([], { cwd });
		expect(gate.evaluate("write", { path: "/etc/passwd" }).action).toBe("approve");
		expect(gate.evaluate("write", { path: "../outside/file.ts" }).action).toBe("approve");
	});
});

describe("loadRules", () => {
	let tempDir: string;
	let projectDir: string;
	let globalDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `permission-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		globalDir = join(tempDir, "global");
		mkdirSync(join(projectDir, ".draht"), { recursive: true });
		mkdirSync(globalDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads project rules after global rules so project rules take precedence", () => {
		writeFileSync(
			join(globalDir, "permissions.yml"),
			`
rules:
  - tool: bash
    pattern: "git push *"
    action: approve
`,
		);
		writeFileSync(
			join(projectDir, ".draht", "permissions.yml"),
			`
rules:
  - tool: bash
    pattern: "git push *"
    action: allow
`,
		);

		const rules = loadRules(projectDir, globalDir);
		const gate = new PermissionGate(rules, { cwd: projectDir });
		const decision = gate.evaluate("bash", { command: "git push origin main" });
		expect(decision.action).toBe("allow");
	});

	it("falls back to global rules when the project has no matching rule", () => {
		writeFileSync(
			join(globalDir, "permissions.yml"),
			`
rules:
  - tool: bash
    pattern: "rm -rf *"
    action: deny
`,
		);
		writeFileSync(
			join(projectDir, ".draht", "permissions.yml"),
			`
rules:
  - tool: write
    action: approve
`,
		);

		const rules = loadRules(projectDir, globalDir);
		const gate = new PermissionGate(rules, { cwd: projectDir });
		expect(gate.evaluate("bash", { command: "rm -rf /" }).action).toBe("deny");
	});

	it("returns an empty array when neither file exists", () => {
		expect(loadRules(join(tempDir, "nowhere"), join(tempDir, "nowhere-global"))).toEqual([]);
	});
});
