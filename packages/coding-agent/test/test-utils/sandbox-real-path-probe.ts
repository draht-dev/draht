/**
 * The R44-SBX.3 real-path security assertions, written **once** and executed
 * under every runtime that ships them.
 *
 * `packages/coding-agent`'s tests run under vitest/node, but the released
 * `draht` binaries are built with `bun build --compile`. Those two runtimes do
 * not agree about `fs.realpathSync.native`: bun collapses `..` lexically before
 * resolving symlinks, node does not. A symlink-escape check that only ever ran
 * under node therefore proved nothing about the artefact users install -- which
 * is exactly how `isPathWritable()` came to answer `true`, in every shipped
 * binary, for a path the kernel writes outside the allowlist.
 *
 * So this file is a plain module with no test-framework imports, runnable three
 * ways:
 *
 * - imported by `test/sandbox-real-path-runtime.test.ts` (in-process, node);
 * - `node test/test-utils/sandbox-real-path-probe.ts`;
 * - `bun test/test-utils/sandbox-real-path-probe.ts`.
 *
 * Run directly it prints one marker line of JSON and exits non-zero if any check
 * failed, so the vitest suite can spawn it under `bun` and compare the answers
 * to node's field by field.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathWritable, resolveSandboxPolicy } from "../../src/core/sandbox/policy.ts";
import { resolveRealPath } from "../../src/core/sandbox/real-path.ts";

/** Prefixes the JSON line so it survives whatever else a runtime prints on startup. */
export const REAL_PATH_PROBE_MARKER = "__DRAHT_REALPATH_PROBE__";

export interface RealPathProbeCheck {
	/** Stable identifier -- the vitest suite compares node's and bun's answers by name. */
	readonly name: string;
	readonly expected: string;
	readonly actual: string;
	readonly ok: boolean;
}

export interface RealPathProbeResult {
	readonly runtime: string;
	readonly checks: readonly RealPathProbeCheck[];
}

function runtimeName(): string {
	const bun = (globalThis as { Bun?: { version: string } }).Bun;
	return bun ? `bun ${bun.version}` : `node ${process.version}`;
}

/**
 * Builds a throwaway tree with a symlink out of the project, then asserts the
 * properties R44-SBX.3 is about. Every check is `expected` vs `actual` strings
 * so a runtime disagreement shows the two answers rather than just `false`.
 */
export function runRealPathProbe(): RealPathProbeResult {
	// realpath the root up front: on macOS `os.tmpdir()` is a symlink to /private/var.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "draht-realpath-probe-")));
	try {
		const project = join(root, "project");
		const outside = join(root, "outside");
		const outsideSub = join(outside, "sub");
		const fakeTmp = join(root, "tmp");
		const fakeHome = join(root, "home");
		for (const dir of [project, outsideSub, fakeTmp, fakeHome]) mkdirSync(dir, { recursive: true });
		// A symlink INSIDE the project pointing OUTSIDE it -- the exact shape R44-SBX.3 defeats.
		symlinkSync(outsideSub, join(project, "link"), "dir");
		writeFileSync(join(project, "real.txt"), "");

		const { policy } = resolveSandboxPolicy({
			cwd: project,
			tmpDir: fakeTmp,
			homeDir: fakeHome,
			includeDefaultCacheRoots: false,
		});

		const checks: RealPathProbeCheck[] = [];
		const record = (name: string, expected: string, actual: string): void => {
			checks.push({ name, expected, actual, ok: expected === actual });
		};
		const resolved = (input: string): string => {
			const result = resolveRealPath(input, { base: project });
			return result.ok ? result.path : "REFUSED";
		};
		/** Relative to `root` so node's and bun's answers are comparable across two different temp dirs. */
		const relative = (input: string): string => resolved(input).replace(root, "<root>");
		const writable = (candidate: string): string => String(isPathWritable(policy, candidate));

		// --- symlink resolution
		record("symlink resolves to its real target", "<root>/outside/sub", relative(`${project}/link`));
		record("relative symlink resolves to its real target", "<root>/outside/sub", relative("link"));

		// --- `..` applied to a symlink's target, not to its spelling. THE bun divergence.
		record("'..' after a symlink escapes the project", "<root>/outside", relative(`${project}/link/..`));
		record(
			"'..' after a symlink names a file outside the project",
			"<root>/outside/evil.txt",
			relative(`${project}/link/../evil.txt`),
		);

		// --- the security property itself (negative controls)
		record("write through a symlink is not writable", "false", writable(join(project, "link", "evil.txt")));
		record("write through '..' after a symlink is not writable", "false", writable(`${project}/link/../evil.txt`));
		record("a sibling of the project is not writable", "false", writable(join(outside, "evil.txt")));
		record("the home directory is not writable", "false", writable(join(fakeHome, ".ssh", "id_ed25519")));

		// --- positive controls: a checker that always says "no" proves nothing
		record("an existing project file is writable", "true", writable(join(project, "real.txt")));
		record("a not-yet-created project file is writable", "true", writable(join(project, "not-created-yet.txt")));
		record("the OS temp dir is writable", "true", writable(join(fakeTmp, "a.txt")));

		// --- '..' below a directory that does not exist has no determinable target
		record("'..' below a non-existent directory is refused", "REFUSED", resolved(`${project}/nope/../../escape`));

		return { runtime: runtimeName(), checks };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** True when this module is the entry point, under node and under bun alike. */
function isEntryPoint(): boolean {
	const argv = process.argv[1];
	if (!argv) return false;
	try {
		return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	const result = runRealPathProbe();
	process.stdout.write(`\n${REAL_PATH_PROBE_MARKER}${JSON.stringify(result)}\n`);
	process.exitCode = result.checks.every((check) => check.ok) ? 0 : 1;
}
