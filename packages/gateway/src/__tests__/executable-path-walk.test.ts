/** R36-SPAWN.2 — the executable-path gate: symlinked components, the sticky leaf, and containment roots. */

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

/** Spelled out rather than imported: the resolver's own constant would agree with whatever it is later given. */
const MONOREPO_CANDIDATE = resolve(import.meta.dir, "..", "..", "..", "coding-agent", "dist", "cli.js");

const cleanup: string[] = [];

/** `/tmp` is a symlink to `/private/tmp` on macOS, so an unresolved temp path fails the no-follow walk immediately. */
function fullyResolvedTempRoot(prefix: string): string {
	const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
	cleanup.push(dir);
	return dir;
}

function program(path: string, mode = 0o755): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode });
	// macOS drops `chmod g+s` silently on a file whose group the caller is not in; taking the group first prevents that.
	chownSync(path, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
	// `writeFileSync`'s mode is masked by the umask; chmod is not.
	chmodSync(path, mode);
	return path;
}

/** The permission bits actually on disk, as an octal string. */
function modeOf(path: string): string {
	return (statSync(path).mode & 0o7777).toString(8);
}

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
		const root = fullyResolvedTempRoot("xw-sd-");
		const sticky = join(root, "sticky");
		mkdirSync(sticky);
		chmodSync(sticky, 0o1777);
		const bin = program(join(sticky, "draht"));

		// /private/tmp itself is a root-owned 1777 directory: without this exemption every throwaway install on macOS is refused.
		expect(modeOf(sticky)).toBe("1777");
		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});

	test("a sticky REGULAR FILE at the leaf is refused, exactly as 0777 is", () => {
		const root = fullyResolvedTempRoot("xw-sf-");
		const bin = program(join(root, "draht"), 0o1777);

		expect(modeOf(bin)).toBe("1777");
		const sticky = refusal(() => assertSafeExecutablePath(bin, uid));
		expect(sticky.code).toBe("refused");
		expect(sticky.message).toContain("writable by others");
		expect(sticky.message).toContain(bin);

		chmodSync(bin, 0o777);
		expect(modeOf(bin)).toBe("777");
		expect(refusal(() => assertSafeExecutablePath(bin, uid)).message).toContain("writable by others");

		chmodSync(bin, 0o755);
		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});
});

describe("a setuid or setgid leaf is refused", () => {
	test("setuid", () => {
		const root = fullyResolvedTempRoot("xw-su-");
		const bin = program(join(root, "draht"), 0o4755);

		expect(statSync(bin).mode & 0o6000).toBe(0o4000);
		const error = refusal(() => assertSafeExecutablePath(bin, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("setuid or setgid");
		expect(error.message).toContain(bin);
	});

	test("setgid", () => {
		const root = fullyResolvedTempRoot("xw-sg-");
		const bin = program(join(root, "draht"), 0o2755);

		expect(statSync(bin).mode & 0o6000).toBe(0o2000);
		expect(refusal(() => assertSafeExecutablePath(bin, uid)).message).toContain("setuid or setgid");
	});

	test("the same file without either bit resolves", () => {
		const root = fullyResolvedTempRoot("xw-sn-");
		const bin = program(join(root, "draht"), 0o4755);
		chmodSync(bin, 0o755);

		expect(() => assertSafeExecutablePath(bin, uid)).not.toThrow();
	});
});

describe("a symlinked component of the DECLARED path is refused", () => {
	test("through resolveDrahtExecutable, which is where it was being followed", () => {
		const root = fullyResolvedTempRoot("xw-ln-");
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);
		const bin = program(join(real, "draht"));

		const error = refusal(() => resolveDrahtExecutable({ [DRAHT_BIN_ENV]: join(link, "draht") }, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("symlink on the path to the draht binary");
		expect(error.message).toContain(link);

		const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid);
		expect(resolved.target).toBe(bin);
		expect(resolved.executable).toBe(bin);
		expect(resolved.leadingArgs).toEqual([]);
	});

	test("including when the LEAF itself is the link", () => {
		const root = fullyResolvedTempRoot("xw-lf-");
		const bin = program(join(root, "draht"));
		const alias = join(root, "alias");
		symlinkSync(bin, alias);

		const error = refusal(() => resolveDrahtExecutable({ [DRAHT_BIN_ENV]: alias }, uid));
		expect(error.message).toContain("symlink on the path to the draht binary");
		expect(error.message).toContain(alias);
	});

	test("a declared path whose parent is a link to a directory OTHER users own is refused as a link, not as ownership", () => {
		const root = fullyResolvedTempRoot("xw-lt-");
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
		// `/tmp`, `/var` and `/etc` are root-owned symlinks on macOS and `os.tmpdir()` is `/var/folders/…`.
		const platform = lstatSync("/tmp");
		expect(platform.isSymbolicLink()).toBe(true);
		expect(platform.uid).toBe(0);

		// Deliberately NOT realpath'd: this is the /tmp-prefixed string a caller actually holds.
		const unresolved = mkdtempSync("/tmp/xw-pl-");
		cleanup.push(realpathSync(unresolved));
		const bin = program(join(unresolved, "draht"));

		const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid);
		expect(resolved.target).toBe(realpathSync(bin));
		expect(resolved.target.startsWith("/private/tmp/")).toBe(true);
	});
});

describe("the interpreter keeps today's follow-the-link behaviour", () => {
	// `process.execPath` is a symlink on any machine with a version manager, and the resolver hands it to the same `canonicalize`.
	test("an interpreter path that is itself a symlink still resolves", () => {
		const root = fullyResolvedTempRoot("xw-ip-");
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
		const root = fullyResolvedTempRoot("xw-ir-");
		const runtimeOutsideTheApprovedRoot = program(join(root, "runtime", "bun"));
		const projects = join(root, "projects");
		const script = program(join(projects, "app", "dist", "cli.js"));

		const originalExecPath = process.execPath;
		try {
			process.execPath = runtimeOutsideTheApprovedRoot;
			const resolved = resolveDrahtExecutable({ [DRAHT_BIN_ENV]: script }, uid, { approvedRoots: [projects] });
			expect(resolved.executable).toBe(runtimeOutsideTheApprovedRoot);
			expect(resolved.leadingArgs).toEqual([script]);
		} finally {
			process.execPath = originalExecPath;
		}
	});
});

describe("containment: approved and forbidden roots", () => {
	test("a project-local node_modules/.bin binary is allowed with no roots and refused under a forbidden root", () => {
		const root = fullyResolvedTempRoot("xw-pl-");
		const project = join(root, "proj");
		const bin = program(join(project, "node_modules", ".bin", "draht"));

		expect(canonicalize(bin, uid, "the draht binary")).toBe(bin);
		expect(resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid).target).toBe(bin);

		const error = refusal(() =>
			canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [join(project, "node_modules")] }),
		);
		expect(error.code).toBe("refused");
		expect(error.message).toContain("inside a forbidden root");
		expect(error.message).toContain(bin);

		expect(
			refusal(() =>
				resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid, { forbiddenRoots: [join(project, "node_modules")] }),
			).message,
		).toContain("inside a forbidden root");
	});

	test("a binary outside every approved root is refused, and one inside is allowed", () => {
		const root = fullyResolvedTempRoot("xw-ar-");
		const projects = join(root, "projects");
		const inside = program(join(projects, "app", "draht"));
		const outside = program(join(root, "elsewhere", "draht"));

		expect(canonicalize(inside, uid, "the draht binary", { approvedRoots: [projects] })).toBe(inside);

		const error = refusal(() => canonicalize(outside, uid, "the draht binary", { approvedRoots: [projects] }));
		expect(error.message).toContain("not inside an approved root");
		expect(error.message).toContain(outside);
	});

	test("containment stops at a separator: /x/projects-evil is not inside /x/projects", () => {
		const root = fullyResolvedTempRoot("xw-bd-");
		const projects = join(root, "projects");
		mkdirSync(projects, { recursive: true });
		const evil = program(join(`${projects}-evil`, "draht"));

		const error = refusal(() => canonicalize(evil, uid, "the draht binary", { approvedRoots: [projects] }));
		expect(error.message).toContain("not inside an approved root");

		expect(canonicalize(evil, uid, "the draht binary", { forbiddenRoots: [projects] })).toBe(evil);

		const child = program(join(projects, "app", "draht"));
		expect(
			refusal(() => canonicalize(child, uid, "the draht binary", { forbiddenRoots: [projects] })).message,
		).toContain("inside a forbidden root");
	});

	test("an UNRESOLVED root contains its canonical target, in both directions", () => {
		// Roots arrive from configuration uncanonicalised, so on macOS an operator's `/tmp/…` root must still
		// meet a binary `canonicalize` has already turned into `/private/tmp/…`.
		const unresolved = mkdtempSync("/tmp/xw-ur-");
		const canonical = realpathSync(unresolved);
		cleanup.push(canonical);
		expect(canonical).not.toBe(unresolved);

		const bin = program(join(canonical, "app", "draht"));

		expect(canonicalize(bin, uid, "the draht binary", { approvedRoots: [unresolved] })).toBe(bin);
		expect(resolveDrahtExecutable({ [DRAHT_BIN_ENV]: bin }, uid, { approvedRoots: [unresolved] }).target).toBe(bin);

		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [unresolved] })).message,
		).toContain("inside a forbidden root");

		const otherUnresolved = mkdtempSync("/tmp/xw-uo-");
		cleanup.push(realpathSync(otherUnresolved));
		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { approvedRoots: [otherUnresolved] })).message,
		).toContain("not inside an approved root");
	});

	test("a trailing separator on a root does not change containment", () => {
		const root = fullyResolvedTempRoot("xw-ts-");
		const projects = join(root, "projects");
		const bin = program(join(projects, "app", "draht"));

		expect(canonicalize(bin, uid, "the draht binary", { approvedRoots: [`${projects}/`] })).toBe(bin);
		expect(
			refusal(() => canonicalize(bin, uid, "the draht binary", { forbiddenRoots: [`${projects}/`] })).message,
		).toContain("inside a forbidden root");
	});

	test("containment is decided on the CANONICAL path, so `..` cannot escape a forbidden root", () => {
		const root = fullyResolvedTempRoot("xw-dd-");
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
		const resolved = resolveDrahtExecutable({}, uid);
		expect(resolved.target).toBe(realpathSync(MONOREPO_CANDIDATE));
		expect(resolved.leadingArgs).toEqual([realpathSync(MONOREPO_CANDIDATE)]);
		expect(resolved.executable).toBe(realpathSync(process.execPath));
	});
});
