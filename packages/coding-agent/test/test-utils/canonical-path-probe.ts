/**
 * Framework-free assertions about `utils/canonical-path.ts`, executed under vitest/node
 * and again as a subprocess under bun by `test/canonical-path.test.ts`. The two runtimes
 * disagree about backslash names, and the one that ships is bun.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparablePath, realPathStrict, resolveRealSegment, trustKeyPath } from "../../src/utils/canonical-path.ts";

export const CANONICAL_PATH_PROBE_MARKER = "__CANONICAL_PATH_PROBE__";

export interface ProbeCheck {
	name: string;
	actual: string;
	expected: string;
	ok: boolean;
}

export interface CanonicalPathProbeResult {
	runtime: string;
	checks: ProbeCheck[];
}

function runtimeName(): string {
	const bun = (globalThis as { Bun?: { version: string } }).Bun;
	return bun ? `bun ${bun.version}` : `node ${process.version}`;
}

export function runCanonicalPathProbe(): CanonicalPathProbeResult {
	const checks: ProbeCheck[] = [];
	const root = mkdtempSync(join(tmpdir(), "canonical-path-probe-"));
	const real = realPathStrict(root) as string;
	// Recorded relative to the fixture, so two runs in two runtimes are comparable.
	const check = (name: string, actual: unknown, expected: unknown) => {
		const strip = (value: unknown) => (JSON.stringify(value) ?? "undefined").split(real).join("<root>");
		const a = strip(actual);
		const e = strip(expected);
		checks.push({ name, actual: a, expected: e, ok: a === e });
	};
	try {
		mkdirSync(join(real, "target", "deep"), { recursive: true });
		symlinkSync(join(real, "target"), join(real, "link"));
		writeFileSync(join(real, "target", "file.txt"), "x");
		symlinkSync(join(real, "nowhere"), join(real, "dangling"));

		check("realPathStrict follows a directory symlink", realPathStrict(join(real, "link")), join(real, "target"));
		check(
			"realPathStrict follows a symlink to a file",
			realPathStrict(join(real, "link", "file.txt")),
			join(real, "target", "file.txt"),
		);
		check("realPathStrict fails on a missing path", realPathStrict(join(real, "nope")), undefined);
		check("realPathStrict fails on a dangling symlink", realPathStrict(join(real, "dangling")), undefined);
		check("realPathStrict resolves `..` physically", realPathStrict(`${real}/link/deep/..`), join(real, "target"));

		check(
			"trustKeyPath spells an unresolvable suffix literally",
			trustKeyPath(join(real, "target", "nope", "deeper")),
			join(real, "target", "nope", "deeper"),
		);
		check(
			"trustKeyPath pops `..` off a failed segment",
			trustKeyPath(`${real}/target/nope/..`),
			join(real, "target"),
		);
		check("comparablePath resolves a symlink", comparablePath(join(real, "link")), join(real, "target"));
		check("comparablePath keeps a missing leaf", comparablePath(join(real, "nope")), join(real, "nope"));

		// A backslash is an ordinary POSIX byte. bun rewrites it to "/" before the syscall,
		// so both of these answer the *other* directory there unless the guard holds.
		mkdirSync(join(real, "a\\b"), { recursive: true });
		mkdirSync(join(real, "a", "b"), { recursive: true });
		writeFileSync(join(real, "a", "b", "marker"), "wrong-tree");
		check("a backslash name resolves to itself", realPathStrict(join(real, "a\\b")), join(real, "a\\b"));
		check(
			"a backslash name is not the nested pair",
			realPathStrict(join(real, "a", "b")) === realPathStrict(join(real, "a\\b")),
			false,
		);
		mkdirSync(join(real, "q", "r"), { recursive: true });
		check("a backslash spelling of a nested pair does not exist", realPathStrict(join(real, "q\\r")), undefined);
		symlinkSync(join(real, "target"), join(real, "s\\t"));
		check("a symlink named through a backslash is unresolvable", realPathStrict(join(real, "s\\t")), undefined);
		mkdirSync(join(real, "u\\v"), { recursive: true });
		symlinkSync(join(real, "target"), join(real, "u\\v", "inner"));
		check(
			"a symlink below a backslash-named ancestor is unresolvable",
			realPathStrict(join(real, "u\\v", "inner")),
			undefined,
		);

		const missing = resolveRealSegment(real, "nope");
		check("resolveRealSegment reports a missing name as missing", missing.ok === false && missing.missing, true);
		const backslashLink = resolveRealSegment(real, "s\\t");
		check(
			"resolveRealSegment reports a backslash symlink as unresolvable, not missing",
			backslashLink.ok === false && backslashLink.missing,
			false,
		);
		const ok = resolveRealSegment(real, "link");
		check("resolveRealSegment resolves a plain name", ok.ok === true && ok.path, join(real, "target"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	return { runtime: runtimeName(), checks };
}

if (process.argv[1]?.endsWith("canonical-path-probe.ts")) {
	process.stdout.write(`\n${CANONICAL_PATH_PROBE_MARKER}${JSON.stringify(runCanonicalPathProbe())}\n`);
}
