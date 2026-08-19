/**
 * R44-SBX.6 -- the `BashOperations` wrapper.
 *
 * Three questions, and only three:
 *
 * 1. **Off** -- is the wrapper invisible? The bar is byte-identical behaviour,
 *    so the parity block drives the *real bash tool* through the local backend
 *    and through the wrapper-with-sandboxing-off and compares the results, error
 *    messages included. Anything less than identical is a regression in the
 *    agent's primary limb.
 * 2. **On + available** -- does a write outside the allowlist actually fail?
 *    (darwin only, against the real `/usr/bin/sandbox-exec`.)
 * 3. **On + unavailable** -- does it fall back *cleanly*, and, crucially, does
 *    it refuse to masquerade? The fallback must be a real unconfined run that
 *    says so, not a sandbox-shaped shrug: the negative control here asserts the
 *    escape write *succeeds*, because a fallback that silently blocked it would
 *    be indistinguishable from confinement it never had.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxedBashOperations, type SandboxNotice } from "../src/core/sandbox/bash-operations.ts";
import {
	createSeatbeltSandboxExecutor,
	type SandboxExecutor,
	type SandboxPolicy,
	SandboxUnavailableError,
} from "../src/core/sandbox/index.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

const isDarwin = process.platform === "darwin";

/** Prints the sandbox marker in brackets: `[1]` inside a sandbox, `[]` outside one. */
const MARKER_PROBE = 'printf "[%s]" "$DRAHT_SANDBOX"';

let workRoot: string;
let project: string;
let outside: string;
let fakeTmp: string;
let fakeHome: string;

beforeAll(() => {
	workRoot = realpathSync(mkdtempSync(join(tmpdir(), "draht-sandbox-bashops-")));
	project = join(workRoot, "project");
	outside = join(workRoot, "outside");
	fakeTmp = join(workRoot, "tmp");
	fakeHome = join(workRoot, "home");
	for (const dir of [project, outside, fakeTmp, fakeHome]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
	rmSync(workRoot, { recursive: true, force: true });
});

/** Policy inputs pinned to this test's throwaway tree, so no real cache root is involved. */
const policyOverrides = () => ({ tmpDir: fakeTmp, homeDir: fakeHome, includeDefaultCacheRoots: false });

/** Runs one command through the bash tool and flattens both outcomes into one comparable shape. */
async function runTool(
	operations: BashOperations,
	command: string,
	options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; text: string }> {
	const tool = createBashTool(options.cwd ?? project, { operations, exposeSessionEnvironment: false });
	try {
		const result = await tool.execute("call", { command, timeout: options.timeout }, options.signal);
		const text = (result.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

/** An executor that reports `available` and records what it was asked to run, without running anything. */
function recordingExecutor(): SandboxExecutor & {
	readonly execCalls: Array<{ command: string; cwd: string; policy: SandboxPolicy }>;
	statusCalls: number;
} {
	const execCalls: Array<{ command: string; cwd: string; policy: SandboxPolicy }> = [];
	const executor = {
		name: "recording",
		execCalls,
		statusCalls: 0,
		status: async () => {
			executor.statusCalls++;
			return { available: true as const };
		},
		exec: async (command: string, cwd: string, policy: SandboxPolicy) => {
			execCalls.push({ command, cwd, policy });
			return { exitCode: 0 };
		},
	};
	return executor;
}

/** An executor that is unavailable and screams if anything tries to run through it anyway. */
function unavailableExecutor(reason: string): SandboxExecutor & { execCalls: number; statusCalls: number } {
	const executor = {
		name: "stub-unavailable",
		execCalls: 0,
		statusCalls: 0,
		status: async () => {
			executor.statusCalls++;
			return { available: false as const, reason };
		},
		exec: async () => {
			executor.execCalls++;
			throw new SandboxUnavailableError(reason);
		},
	};
	return executor;
}

// ---------------------------------------------------------------------------
// 1. Sandboxing off -- the wrapper must be invisible
// ---------------------------------------------------------------------------

describe("createSandboxedBashOperations, sandboxing off", () => {
	it("forwards command, cwd and the options object to the wrapped backend untouched", async () => {
		const seen: Array<{ command: string; cwd: string; options: unknown }> = [];
		const inner: BashOperations = {
			exec: async (command, cwd, options) => {
				seen.push({ command, cwd, options });
				return { exitCode: 7 };
			},
		};
		const ops = createSandboxedBashOperations({ operations: inner, enabled: false });

		const passedOptions = { onData: () => {}, timeout: 12, env: { FOO: "bar" } };
		const result = await ops.exec("echo hi", project, passedOptions);

		expect(result).toEqual({ exitCode: 7 });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.command).toBe("echo hi");
		expect(seen[0]!.cwd).toBe(project);
		// Same object, not a reconstructed lookalike: a copy is where a divergence hides.
		expect(seen[0]!.options).toBe(passedOptions);
	});

	it("never consults the sandbox executor at all", async () => {
		const executor = recordingExecutor();
		const ops = createSandboxedBashOperations({
			executor,
			enabled: false,
			policy: policyOverrides,
		});

		await ops.exec("true", project, { onData: () => {} });

		expect(executor.statusCalls).toBe(0);
		expect(executor.execCalls).toHaveLength(0);
	});

	it("produces byte-identical bash tool results compared with the local backend", async () => {
		const local = createLocalBashOperations();
		const wrapped = createSandboxedBashOperations({ enabled: false, policy: policyOverrides });

		const cases: Array<{ name: string; command: string; cwd?: string; timeout?: number }> = [
			{ name: "stdout", command: "echo hello parity" },
			{ name: "stderr and exit code", command: "echo to-stderr 1>&2; exit 3" },
			{ name: "no output", command: "true" },
			{ name: "multi-line", command: "printf 'a\\nb\\nc\\n'" },
			{ name: "cwd is honoured", command: "pwd" },
			{ name: "missing cwd", command: "echo nope", cwd: join(workRoot, "no-such-dir") },
			{ name: "timeout", command: "sleep 5", timeout: 1 },
			{ name: "no sandbox marker", command: MARKER_PROBE },
		];

		for (const testCase of cases) {
			const expected = await runTool(local, testCase.command, testCase);
			const actual = await runTool(wrapped, testCase.command, testCase);
			expect(actual, `case: ${testCase.name}`).toEqual(expected);
		}
	});

	it("aborts identically to the local backend", async () => {
		const abortBoth = async (operations: BashOperations) => {
			const controller = new AbortController();
			const pending = runTool(operations, "sleep 5", { signal: controller.signal });
			setTimeout(() => controller.abort(), 50);
			return pending;
		};

		const expected = await abortBoth(createLocalBashOperations());
		const actual = await abortBoth(createSandboxedBashOperations({ enabled: false, policy: policyOverrides }));
		expect(actual).toEqual(expected);
	});
});

// ---------------------------------------------------------------------------
// 2. Sandboxing on with an available backend
// ---------------------------------------------------------------------------

describe("createSandboxedBashOperations, sandboxing on", () => {
	it("resolves a policy per invocation from the invocation's own cwd", async () => {
		const executor = recordingExecutor();
		const ops = createSandboxedBashOperations({ executor, enabled: true, policy: policyOverrides });

		await ops.exec("true", project, { onData: () => {} });

		expect(executor.execCalls).toHaveLength(1);
		const { policy } = executor.execCalls[0]!;
		expect(policy.writePaths).toContain(realpathSync(project));
		expect(policy.writePaths).toContain(realpathSync(fakeTmp));
		expect(policy.writePaths).not.toContain(realpathSync(outside));
		expect(policy.network).toBe("on");
		expect(policy.allowPrivilegeEscalation).toBe(false);
	});

	it("asks the backend for its status once, not once per command", async () => {
		const executor = recordingExecutor();
		const ops = createSandboxedBashOperations({ executor, enabled: true, policy: policyOverrides });

		for (let i = 0; i < 3; i++) await ops.exec("true", project, { onData: () => {} });

		expect(executor.statusCalls).toBe(1);
		expect(executor.execCalls).toHaveLength(3);
	});

	it("surfaces dropped write paths once each rather than once per command", async () => {
		const executor = recordingExecutor();
		const notices: SandboxNotice[] = [];
		const ops = createSandboxedBashOperations({
			executor,
			enabled: true,
			onNotice: (notice) => notices.push(notice),
			// `/` as a write root is the documented refusal: an allowlist containing
			// the filesystem root is not an allowlist.
			policy: () => ({ ...policyOverrides(), extraWritePaths: ["/"] }),
		});

		for (let i = 0; i < 3; i++) await ops.exec("true", project, { onData: () => {} });

		const rejected = notices.filter((notice) => notice.kind === "write-path-rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ kind: "write-path-rejected", input: "/" });
		expect(executor.execCalls[0]!.policy.writePaths).not.toContain("/");
	});

	it("refuses to run at all from a cwd that would make the allowlist $HOME, and says why", async () => {
		// D2: the policy used to accept `$HOME` as the cwd silently -- no `rejected`
		// entry, no notice -- so a session started from the home directory ran with an
		// allowlist that confined nothing while still reporting itself sandboxed.
		let fallbackCalls = 0;
		const inner: BashOperations = {
			exec: async () => {
				fallbackCalls++;
				return { exitCode: 0 };
			},
		};
		const executor = recordingExecutor();
		const notices: SandboxNotice[] = [];
		const ops = createSandboxedBashOperations({
			operations: inner,
			executor,
			enabled: true,
			onNotice: (notice) => notices.push(notice),
			policy: policyOverrides,
		});

		await expect(ops.exec("true", fakeHome, { onData: () => {} })).rejects.toThrow(SandboxUnavailableError);
		await expect(ops.exec("true", fakeHome, { onData: () => {} })).rejects.toThrow(/home directory/);
		expect(executor.execCalls).toHaveLength(0);
		expect(fallbackCalls).toBe(0);
		expect(notices.filter((notice) => notice.kind === "unavailable")).toHaveLength(0);

		// The same wrapper still confines an ordinary project directory.
		await ops.exec("true", project, { onData: () => {} });
		expect(executor.execCalls).toHaveLength(1);
	});

	it("refuses to run unconfined when a single invocation cannot be confined", async () => {
		let fallbackCalls = 0;
		const inner: BashOperations = {
			exec: async () => {
				fallbackCalls++;
				return { exitCode: 0 };
			},
		};
		const executor: SandboxExecutor = {
			name: "confinement-broke",
			status: async () => ({ available: true }),
			exec: async () => {
				throw new SandboxUnavailableError("profile could not be generated for this policy");
			},
		};
		const ops = createSandboxedBashOperations({
			operations: inner,
			executor,
			enabled: true,
			policy: policyOverrides,
		});

		await expect(ops.exec("true", project, { onData: () => {} })).rejects.toThrow(SandboxUnavailableError);
		expect(fallbackCalls).toBe(0);
	});

	it("refuses rather than running a command whose policy cannot be built", async () => {
		const executor = recordingExecutor();
		const ops = createSandboxedBashOperations({
			executor,
			enabled: true,
			// `..` below a segment that does not exist: its real target depends on
			// what gets created there, so the policy cannot be resolved at all.
			policy: () => ({ ...policyOverrides(), tmpDir: `${workRoot}/missing/../escape` }),
		});

		await expect(ops.exec("true", project, { onData: () => {} })).rejects.toThrow(SandboxUnavailableError);
		expect(executor.execCalls).toHaveLength(0);
	});

	it("follows a live on/off toggle", async () => {
		const executor = recordingExecutor();
		let enabled = false;
		let fallbackCalls = 0;
		const inner: BashOperations = {
			exec: async () => {
				fallbackCalls++;
				return { exitCode: 0 };
			},
		};
		const ops = createSandboxedBashOperations({
			operations: inner,
			executor,
			enabled: () => enabled,
			policy: policyOverrides,
		});

		await ops.exec("true", project, { onData: () => {} });
		enabled = true;
		await ops.exec("true", project, { onData: () => {} });

		expect(fallbackCalls).toBe(1);
		expect(executor.execCalls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 3. On + a real backend -- the confinement claim itself (darwin only)
// ---------------------------------------------------------------------------

describe.skipIf(!isDarwin)("createSandboxedBashOperations against the real Seatbelt backend", () => {
	const ops = () =>
		createSandboxedBashOperations({
			executor: createSeatbeltSandboxExecutor(),
			enabled: true,
			policy: policyOverrides,
		});

	it("fails a write outside the allowlist through the real bash tool", async () => {
		const escapeTarget = join(outside, "escape-through-the-tool.txt");
		const result = await runTool(ops(), `echo pwned > ${JSON.stringify(escapeTarget)}`);

		expect(result.ok).toBe(false);
		expect(existsSync(escapeTarget)).toBe(false);
	}, 60_000);

	it("still allows a write inside the project (positive control)", async () => {
		const allowed = join(project, "allowed.txt");
		const result = await runTool(ops(), `echo fine > ${JSON.stringify(allowed)}`);

		expect(result).toMatchObject({ ok: true });
		expect(existsSync(allowed)).toBe(true);
	}, 60_000);

	it("marks the confined child so nothing has to guess whether it was sandboxed", async () => {
		const result = await runTool(ops(), MARKER_PROBE);

		expect(result.ok).toBe(true);
		expect(result.text).toContain("[1]");
	}, 60_000);

	it("reports available only after the self-test has actually passed", async () => {
		const wrapper = ops();
		await expect(wrapper.sandboxStatus()).resolves.toEqual({ available: true });
	}, 60_000);
});

// ---------------------------------------------------------------------------
// 4. On + unavailable -- fall back, say so once, and never pretend
// ---------------------------------------------------------------------------

describe("createSandboxedBashOperations with an unavailable backend", () => {
	it("runs the command exactly as today rather than failing it", async () => {
		const executor = unavailableExecutor('no sandbox backend exists for platform "plan9"');
		const ops = createSandboxedBashOperations({ executor, enabled: true, policy: policyOverrides });

		const expected = await runTool(createLocalBashOperations(), "echo fallback works");
		const actual = await runTool(ops, "echo fallback works");

		expect(actual).toEqual(expected);
		expect(executor.execCalls).toBe(0);
	});

	it("really is unconfined, and does not claim otherwise", async () => {
		const executor = unavailableExecutor("stub backend cannot confine");
		const ops = createSandboxedBashOperations({ executor, enabled: true, policy: policyOverrides });

		// The escape write must SUCCEED. A fallback that blocked it would be
		// indistinguishable from confinement the session does not have.
		const escapeTarget = join(outside, "fallback-is-honest.txt");
		const written = await runTool(ops, `echo unconfined > ${JSON.stringify(escapeTarget)}`);
		expect(written.ok).toBe(true);
		expect(existsSync(escapeTarget)).toBe(true);

		// ... and the child must not carry the sandbox marker.
		const marker = await runTool(ops, MARKER_PROBE);
		expect(marker.text).toContain("[]");
	});

	it("surfaces the reason once, not once per command", async () => {
		const notices: SandboxNotice[] = [];
		const executor = unavailableExecutor("sandbox-exec not found -- refusing to claim confinement");
		const ops = createSandboxedBashOperations({
			executor,
			enabled: true,
			onNotice: (notice) => notices.push(notice),
			policy: policyOverrides,
		});

		for (let i = 0; i < 5; i++) await ops.exec("true", project, { onData: () => {} });

		const unavailable = notices.filter((notice) => notice.kind === "unavailable");
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0]).toMatchObject({
			kind: "unavailable",
			backend: "stub-unavailable",
			reason: "sandbox-exec not found -- refusing to claim confinement",
		});
		expect(executor.statusCalls).toBe(1);
	});

	it("reports the same reason through sandboxStatus for the caller's own UI", async () => {
		const executor = unavailableExecutor("kernel too old for landlock");
		const ops = createSandboxedBashOperations({ executor, enabled: true, policy: policyOverrides });

		await expect(ops.sandboxStatus()).resolves.toEqual({
			available: false,
			reason: "kernel too old for landlock",
		});
	});

	it("treats a throwing status() as unavailable instead of letting it reach the caller", async () => {
		const executor: SandboxExecutor = {
			name: "explodes",
			status: async () => {
				throw new Error("status blew up");
			},
			exec: async () => {
				throw new Error("must not run");
			},
		};
		const notices: SandboxNotice[] = [];
		const ops = createSandboxedBashOperations({
			executor,
			enabled: true,
			onNotice: (notice) => notices.push(notice),
			policy: policyOverrides,
		});

		const result = await runTool(ops, "echo still works");
		expect(result.ok).toBe(true);
		expect(result.text).toContain("still works");
		expect(notices.filter((notice) => notice.kind === "unavailable")).toHaveLength(1);
	});
});
