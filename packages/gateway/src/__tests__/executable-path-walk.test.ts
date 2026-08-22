/**
 * R36-SPAWN.2 — the three refusals the executable-path gate did NOT make.
 *
 * The walk in `spawn-primitive.ts` was already real: absolute-only, no PATH
 * branch, every component owned by this uid or root, no group/world write, a
 * regular file at the leaf. What it did not do — each of these was PROVEN by
 * calling the real exported functions before it was fixed, not inferred from
 * reading:
 *
 *  1. A SYMLINKED DIRECTORY COMPONENT WAS FOLLOWED. `canonicalize` called
 *     `realpathSync` and only then asserted, so the walk's symlink branch could
 *     never fire — its own comment called itself "unreachable". `DRAHT_BIN`
 *     pointing through a symlinked directory resolved ALLOWED.
 *  2. A LEAF AT MODE 1777 WAS ALLOWED while the same leaf at 0777 was refused,
 *     because the sticky exemption — a statement about directories, whose
 *     justification is that a non-owner cannot rename or unlink our entry — was
 *     applied to the leaf as well.
 *  3. NOTHING CONSTRAINED WHERE THE BINARY LIVED. An absolute project-local
 *     `node_modules/.bin/draht` passed, because no containment rule existed.
 *
 * ## Why these are exercised where they are
 *
 * The symlink case is driven THROUGH `resolveDrahtExecutable`, never by calling
 * `assertSafeExecutablePath` directly. Calling the assertion directly is exactly
 * how this defect survived: the assertion refuses a link and always did, while
 * no production path ever handed it one. A test at that seam passes on the
 * broken code.
 *
 * Every refusal here is paired with a positive control on the same fixture — the
 * same binary through its real path, the same layout with no roots configured.
 * Without the positive half, a `canonicalize` that refused everything would pass
 * this file.
 *
 * The interpreter cases are the load-bearing NEGATIVE ones: `process.execPath`
 * under a version manager is routinely a symlink and lives nowhere near a
 * project root, so a no-follow rule or a root constraint leaking onto the
 * interpreter means this daemon resolves no runtime and Phase 36 lands with
 * nothing able to start.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	assertSafeExecutablePath,
	canonicalize,
	DRAHT_BIN_ENV,
	resolveDrahtExecutable,
	SpawnRefusedError,
} from "../session/spawn-primitive.js";

const uid = process.getuid?.() ?? 0;

/**
 * The monorepo candidate `resolveDrahtExecutable` finds with no `DRAHT_BIN` set.
 *
 * Computed the same way the resolver computes it — `packages/coding-agent/dist/cli.js`
 * relative to a file three levels under `packages/` — because the property under
 * test is that THAT path keeps resolving. Written out rather than imported for
 * the usual reason: importing the resolver's own constant would make the
 * assertion agree with any value it is later given.
 */
const MONOREPO_CANDIDATE = resolve(import.meta.dir, "..", "..", "..", "coding-agent", "dist", "cli.js");

const cleanup: string[] = [];

/**
 * A temp root with EVERY symlink already resolved.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, so an unresolved temp path
 * fails the no-follow walk at its first component and every fixture below would
 * refuse for a reason that has nothing to do with what it is testing.
 */
function tempRoot(prefix: string): string {
	const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
	cleanup.push(dir);
	return dir;
}

/** Create `path`'s parents and write an executable-looking regular file at `mode`. */
function program(path: string, mode = 0o755): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode });
	// A file created under /private/tmp inherits gid 0 (wheel), and macOS refuses
	// `chmod g+s` on a file whose group the caller is not in — silently, by
	// dropping the bit rather than raising. Taking group ownership first is what
	// makes the setgid fixture actually carry setgid.
	chownSync(path, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
	// `writeFileSync`'s mode is masked by the umask; chmod is not.
	chmodSync(path, mode);
	return path;
}

/** The permission bits actually on disk, as an octal string — asserted, never assumed. */
function modeOf(path: string): string {
	return (statSync(path).mode & 0o7777).toString(8);
}

/**
 * Run `attempt` and return the {@link SpawnRefusedError} it raised.
 *
 * A bare `toThrow()` would be satisfied by a `TypeError` from a check deleted
 * badly, and would say nothing about WHICH refusal fired — which is the entire
 * content of these cases, since several fixtures could refuse for more than one
 * reason if the wrong predicate were doing the work.
 */
function refusal(attempt: () => unknown): SpawnRefusedError {
	try {
		attempt();
	} catch (error) {
		if (error instanceof SpawnRefusedError) return error;
		throw error;
	}
	throw new Error("expected a SpawnRefusedError, and the call returned normally");
}

beforeAll(() => {
	if (!existsSync(MONOREPO_CANDIDATE)) {
		throw new Error(
			`${MONOREPO_CANDIDATE} does not exist — run \`bun run build\` in packages/coding-agent. ` +
				"This file asserts that the dev checkout keeps resolving; skipping that would delete the assertion.",
		);
	}
});

afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("the sticky exemption is about directories", () => {
	test("a sticky directory on the path is still allowed", () => {
		const root = tempRoot("xw-sd-");
		const sticky = join(root, "sticky");
		mkdirSync(sticky);
		chmodSync(sticky, 0o1777);
		const bin = program(join(sticky, "draht"));

		// /private/tmp itself is a root-owned 1777 directory, so removing this
		// exemption would refuse every throwaway install on macOS. It stays.
		expect(modeOf(sticky)).toBe("1777");
		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});

	test("a sticky REGULAR FILE at the leaf is refused, exactly as 0777 is", () => {
		const root = tempRoot("xw-sf-");
		const bin = program(join(root, "draht"), 0o1777);

		// The bit is verified on disk first: an assertion about mode 1777 that ran
		// against a file the umask had quietly turned into 0755 would pass forever.
		expect(modeOf(bin)).toBe("1777");
		const sticky = refusal(() => assertSafeExecutablePath(bin, uid));
		expect(sticky.code).toBe("refused");
		expect(sticky.message).toContain("writable by others");
		expect(sticky.message).toContain(bin);

		// The control: the same file without the sticky bit refused before this
		// change too, so the pair is what shows the exemption is no longer leaking
		// onto the leaf rather than that files are refused in general.
		chmodSync(bin, 0o777);
		expect(modeOf(bin)).toBe("777");
		expect(refusal(() => assertSafeExecutablePath(bin, uid)).message).toContain("writable by others");

		// And a leaf nobody else can write is still fine.
		chmodSync(bin, 0o755);
		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});
});

describe("a setuid or setgid leaf is refused", () => {
	test("setuid", () => {
		const root = tempRoot("xw-su-");
		const bin = program(join(root, "draht"), 0o4755);

		expect(statSync(bin).mode & 0o6000).toBe(0o4000);
		const error = refusal(() => assertSafeExecutablePath(bin, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("setuid or setgid");
		expect(error.message).toContain(bin);
	});

	test("setgid", () => {
		const root = tempRoot("xw-sg-");
		const bin = program(join(root, "draht"), 0o2755);

		// If the platform refused to set the bit there is nothing to assert about,
		// and silently passing would be a lie — so the mode is asserted, not read.
		expect(statSync(bin).mode & 0o6000).toBe(0o2000);
		expect(refusal(() => assertSafeExecutablePath(bin, uid)).message).toContain("setuid or setgid");
	});

	test("the same file without either bit resolves", () => {
		const root = tempRoot("xw-sn-");
		const bin = program(join(root, "draht"), 0o4755);
		chmodSync(bin, 0o755);

		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});
});

describe("a symlinked component of the DECLARED path is refused", () => {
	test("through resolveDrahtExecutable, which is where it was being followed", () => {
		const root = tempRoot("xw-ln-");
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);
		const bin = program(join(real, "draht"));

		// Before this change this call RETURNED, resolved to <root>/real/draht: the
		// resolver realpath'd the link away and then asserted about the result. The
		// assertion it reached was correct and could not fire.
		const error = refusal(() => resolveDrahtExecutable({ [DRAHT_BIN_ENV]: join(link, "draht") }, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("symlink on the path to the draht binary");
		expect(error.message).toContain(link);

		// POSITIVE CONTROL — the identical binary, named by its real path, resolves.
		// Without this the case above is satisfied by a resolver that refuses
		// everything.
		const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid);
		expect(resolved.target).toBe(bin);
		expect(resolved.executable).toBe(bin);
		expect(resolved.leadingArgs).toEqual([]);
	});

	test("including when the LEAF itself is the link", () => {
		const root = tempRoot("xw-lf-");
		const bin = program(join(root, "draht"));
		const alias = join(root, "alias");
		symlinkSync(bin, alias);

		const error = refusal(() => resolveDrahtExecutable({ [DRAHT_BIN_ENV]: alias }, uid));
		expect(error.message).toContain("symlink on the path to the draht binary");
		expect(error.message).toContain(alias);
	});

	test("a declared path whose parent is a link to a directory OTHER users own is refused as a link, not as ownership", () => {
		// /tmp is root-owned and sticky, so a link pointing there would otherwise
		// pass the ownership walk after being followed. The refusal must name the
		// link, which is the property that survives an attacker re-pointing it.
		const root = tempRoot("xw-lt-");
		const link = join(root, "tmp");
		symlinkSync("/private/tmp", link);
		const bin = program(join(realpathSync("/private/tmp"), `xw-${process.pid}-draht`));
		cleanup.push(bin);

		const error = refusal(() =>
			resolveDrahtExecutable({ [DRAHT_BIN_ENV]: join(link, `xw-${process.pid}-draht`) }, uid),
		);
		expect(error.message).toContain("symlink on the path to the draht binary");
	});

	test("but a ROOT-OWNED platform link is followed, or nothing under /tmp could ever be declared", () => {
		// `/tmp`, `/var` and `/etc` are root-owned symlinks on macOS, and
		// `os.tmpdir()` is `/var/folders/…`. A no-follow rule without this exemption
		// refuses every throwaway install and every operator who points DRAHT_BIN at
		// an unpacked archive — including the daemon acceptance in
		// session-resume.e2e.test.ts, which declares a DRAHT_BIN under /tmp.
		const platform = lstatSync("/tmp");
		expect(platform.isSymbolicLink()).toBe(true);
		expect(platform.uid).toBe(0);

		// Deliberately NOT realpath'd: this is the /tmp-prefixed string a caller
		// actually holds.
		const unresolved = mkdtempSync("/tmp/xw-pl-");
		cleanup.push(realpathSync(unresolved));
		const bin = program(join(unresolved, "draht"));

		const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid);
		expect(resolved.target).toBe(realpathSync(bin));
		expect(resolved.target.startsWith("/private/tmp/")).toBe(true);
	});
});

describe("the interpreter keeps today's follow-the-link behaviour", () => {
	/**
	 * `process.execPath` IS a symlink on any machine with a version manager, and
	 * the resolver hands it to the same `canonicalize`. If the no-follow rule is
	 * applied there too, no script target can ever resolve.
	 */
	test("an interpreter path that is itself a symlink still resolves", () => {
		const root = tempRoot("xw-ip-");
		const realRuntime = program(join(root, "runtime", "bun"));
		const linkedRuntime = join(root, "bun-link");
		symlinkSync(realRuntime, linkedRuntime);
		const script = program(join(root, "cli.js"));

		const originalExecPath = process.execPath;
		try {
			process.execPath = linkedRuntime;
			const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: script }, uid);
			expect(resolved.executable).toBe(realRuntime);
			expect(resolved.leadingArgs).toEqual([script]);
			expect(resolved.target).toBe(script);
		} finally {
			process.execPath = originalExecPath;
		}
	});

	test("and resolves even when approved roots would exclude it", () => {
		const root = tempRoot("xw-ir-");
		const runtime = program(join(root, "runtime", "bun"));
		const projects = join(root, "projects");
		const script = program(join(projects, "app", "dist", "cli.js"));

		const originalExecPath = process.execPath;
		try {
			process.execPath = runtime;
			// The runtime lives OUTSIDE the approved root on purpose: roots describe
			// where the harness may live, never where the machine keeps its runtime.
			const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: script }, uid, { approvedRoots: [projects] });
			expect(resolved.executable).toBe(runtime);
			expect(resolved.leadingArgs).toEqual([script]);
		} finally {
			process.execPath = originalExecPath;
		}
	});
});

describe("containment: approved and forbidden roots", () => {
	test("a project-local node_modules/.bin binary is allowed with no roots and refused under a forbidden root", () => {
		const root = tempRoot("xw-pl-");
		const project = join(root, "proj");
		const bin = program(join(project, "node_modules", ".bin", "draht"));

		// UNCHANGED BEHAVIOUR, asserted so the new parameters cannot have quietly
		// tightened the default: empty lists mean no constraint.
		expect(canonicalize(bin, uid, "the draht binary")).toBe(bin);
		expect(resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid).target).toBe(bin);

		const error = refusal(() =>
			canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [join(project, "node_modules")] }),
		);
		expect(error.code).toBe("refused");
		expect(error.message).toContain("inside a forbidden root");
		expect(error.message).toContain(bin);

		// The same constraint reaches the resolver, not just the helper.
		expect(
			refusal(() =>
				resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid, { forbiddenRoots: [join(project, "node_modules")] }),
			).message,
		).toContain("inside a forbidden root");
	});

	test("a binary outside every approved root is refused, and one inside is allowed", () => {
		const root = tempRoot("xw-ar-");
		const projects = join(root, "projects");
		const inside = program(join(projects, "app", "draht"));
		const outside = program(join(root, "elsewhere", "draht"));

		expect(canonicalize(inside, uid, "the draht binary", { approvedRoots: [projects] })).toBe(inside);

		const error = refusal(() => canonicalize(outside, uid, "the draht binary", { approvedRoots: [projects] }));
		expect(error.message).toContain("not inside an approved root");
		expect(error.message).toContain(outside);
	});

	test("containment stops at a separator: /x/projects-evil is not inside /x/projects", () => {
		const root = tempRoot("xw-bd-");
		const projects = join(root, "projects");
		mkdirSync(projects, { recursive: true });
		const evil = program(join(`${projects}-evil`, "draht"));

		// `startsWith(root)` alone accepts this — it is the live defect in the
		// daemon's own `isPathAllowed` (config/config.ts). A gate that inherited it
		// would let a directory NAMED like an approved root supply the binary.
		const error = refusal(() => canonicalize(evil, uid, "the draht binary", { approvedRoots: [projects] }));
		expect(error.message).toContain("not inside an approved root");

		// The boundary must hold in the other direction too: forbidding
		// `<root>/projects` must NOT forbid `<root>/projects-evil`, or an
		// over-eager prefix match would refuse unrelated trees and the refusals
		// above would prove nothing about where the line actually is.
		expect(canonicalize(evil, uid, "the draht binary", { forbiddenRoots: [projects] })).toBe(evil);

		// And a real child of the forbidden root IS refused.
		const child = program(join(projects, "app", "draht"));
		expect(
			refusal(() => canonicalize(child, uid, "the draht binary", { forbiddenRoots: [projects] })).message,
		).toContain("inside a forbidden root");
	});

	test("an UNRESOLVED root contains its canonical target, in both directions", () => {
		// The roots this gate will be given come from configuration — a file, a flag, an
		// operator's shell — and nothing canonicalises them on the way in. On macOS that means
		// `/tmp/…`, while `canonicalize` has already turned the binary into `/private/tmp/…`.
		// Compare the two as written and every approved root refuses everything it approves
		// and every forbidden root forbids nothing: `canonicalRoot()`'s `realpathSync` is what
		// makes the comparison meet in the middle, and deleting it survived this file.
		const unresolved = mkdtempSync("/tmp/xw-ur-");
		const canonical = realpathSync(unresolved);
		cleanup.push(canonical);
		// The fixture is only about anything if the two strings actually differ. On a platform
		// where `/tmp` is a real directory this would be vacuous, so it is asserted, not assumed.
		expect(canonical).not.toBe(unresolved);

		const bin = program(join(canonical, "app", "draht"));

		// APPROVED: the canonical binary is inside the root the operator wrote down.
		expect(canonicalize(bin, uid, "the draht binary", { approvedRoots: [unresolved] })).toBe(bin);
		// And the same constraint reaches the resolver, not just the helper.
		expect(resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid, { approvedRoots: [unresolved] }).target).toBe(bin);

		// FORBIDDEN, the mirror: the identical unresolved string must REFUSE the same tree.
		// Without it, a `canonicalRoot` that stopped resolving would look "safe" — it would
		// only ever refuse — while silently disarming every forbidden root in the config.
		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [unresolved] })).message,
		).toContain("inside a forbidden root");

		// NEGATIVE CONTROL: an unresolved root naming a DIFFERENT tree still refuses, so the
		// two assertions above are about resolving the root and not about containment having
		// stopped constraining anything.
		const otherUnresolved = mkdtempSync("/tmp/xw-uo-");
		cleanup.push(realpathSync(otherUnresolved));
		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { approvedRoots: [otherUnresolved] })).message,
		).toContain("not inside an approved root");
	});

	test("a trailing separator on a root does not change containment", () => {
		const root = tempRoot("xw-ts-");
		const projects = join(root, "projects");
		const bin = program(join(projects, "app", "draht"));

		expect(canonicalize(bin, uid, "the draht binary", { approvedRoots: [`${projects}/`] })).toBe(bin);
		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [`${projects}/`] })).message,
		).toContain("inside a forbidden root");
	});

	test("containment is decided on the CANONICAL path, so `..` cannot escape a forbidden root", () => {
		const root = tempRoot("xw-dd-");
		const project = join(root, "proj");
		const bin = program(join(project, "node_modules", ".bin", "draht"));
		const sneaky = join(project, "node_modules", ".bin", "..", ".bin", "draht");

		expect(
			refusal(() =>
				canonicalize(sneaky, uid, "the draht binary", { forbiddenRoots: [join(project, "node_modules")] }),
			).message,
		).toContain("inside a forbidden root");
		expect(bin).toBe(realpathSync(sneaky));
	});
});

describe("the monorepo dev checkout keeps resolving", () => {
	test("with no DRAHT_BIN and no roots configured", () => {
		// R36-SPAWN.2 must not cost every developer their daemon: the fallback
		// candidate is `packages/coding-agent/dist/cli.js` relative to the
		// resolver's own source file, and this repo IS a checkout under whatever
		// prefix it happens to live at, symlinks and all.
		const resolved = resolveDrahtExecutable({}, uid);
		expect(resolved.target).toBe(realpathSync(MONOREPO_CANDIDATE));
		expect(resolved.leadingArgs).toEqual([realpathSync(MONOREPO_CANDIDATE)]);
		expect(resolved.executable).toBe(realpathSync(process.execPath));
	});
});
