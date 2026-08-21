import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createSandboxExecutor,
	excludedWriteRootReason,
	isPathWritable,
	resolveRealPath,
	resolveSandboxPolicy,
	type SandboxExecutor,
	SandboxPolicyError,
	type SandboxPolicyInput,
	SandboxUnavailableError,
} from "../src/core/sandbox/index.ts";

let workRoot: string;
let project: string;
let outside: string;
let outsideSub: string;
let scratch: string;
let fakeTmp: string;
let fakeHome: string;

beforeAll(() => {
	// realpath the root up front: on macOS `os.tmpdir()` is `/var/...`, a symlink to
	// `/private/var`, so every expectation below would otherwise compare a resolved
	// path against an unresolved one.
	workRoot = realpathSync(mkdtempSync(join(tmpdir(), "draht-sandbox-policy-")));
	project = join(workRoot, "project");
	outside = join(workRoot, "outside");
	outsideSub = join(outside, "sub");
	scratch = join(workRoot, "scratch");
	fakeTmp = join(workRoot, "tmp");
	fakeHome = join(workRoot, "home");
	mkdirSync(project);
	mkdirSync(outsideSub, { recursive: true });
	mkdirSync(scratch);
	mkdirSync(fakeTmp);
	mkdirSync(fakeHome);
	// A symlink INSIDE the project pointing OUTSIDE it -- the exact shape R44-SBX.3 exists
	// to defeat.
	symlinkSync(outsideSub, join(project, "link"), "dir");
	writeFileSync(join(project, "real.txt"), "");
});

afterAll(() => {
	rmSync(workRoot, { recursive: true, force: true });
});

function policyFor(overrides: Partial<SandboxPolicyInput> = {}) {
	return resolveSandboxPolicy({
		cwd: project,
		sessionScratchDir: scratch,
		tmpDir: fakeTmp,
		homeDir: fakeHome,
		includeDefaultCacheRoots: false,
		...overrides,
	});
}

function expectResolved(result: ReturnType<typeof resolveRealPath>): string {
	if (!result.ok) throw new Error(`expected resolution to succeed, got: ${result.reason}`);
	return result.path;
}

describe("real-path resolution (R44-SBX.3)", () => {
	it("does not widen the writable set through a symlink inside the project", () => {
		const { policy } = policyFor();

		expect(policy.writePaths).toContain(project);
		expect(policy.writePaths).not.toContain(outsideSub);
		expect(policy.writePaths).not.toContain(outside);

		// A naive `startsWith(project)` check would call this writable. It is not: the real
		// path is outside the project.
		expect(isPathWritable(policy, join(project, "link", "evil.txt"))).toBe(false);
		expect(isPathWritable(policy, join(project, "real.txt"))).toBe(true);
		expect(isPathWritable(policy, join(project, "not-created-yet.txt"))).toBe(true);
	});

	it("records an extraWritePaths symlink as its real target, never its in-project spelling", () => {
		const { policy } = policyFor({ extraWritePaths: [join(project, "link")] });

		expect(policy.writePaths).toContain(outsideSub);
		expect(policy.writePaths).not.toContain(join(project, "link"));
	});

	it("resolves a symlink to its real target", () => {
		expect(expectResolved(resolveRealPath(join(project, "link"), { base: project }))).toBe(outsideSub);
		expect(expectResolved(resolveRealPath("link", { base: project }))).toBe(outsideSub);
	});

	it("does not let '..' traversal escape the writable set", () => {
		const { policy } = policyFor();

		// NOTE: built by string concatenation, not `path.join`, which collapses ".."
		// lexically -- collapsing is precisely the bug under test.
		const lexicallyInside = `${project}/link/../evil.txt`;
		// Lexically this reads as `<project>/evil.txt`. Really it is `<outside>/evil.txt`,
		// because `link` is a symlink and ".." applies to the link's *target*.
		expect(expectResolved(resolveRealPath(lexicallyInside, { base: project }))).toBe(join(outside, "evil.txt"));
		expect(isPathWritable(policy, lexicallyInside)).toBe(false);

		// The same traversal as a configured write path buys exactly the directory it names
		// and nothing above it.
		const { policy: widened } = policyFor({ extraWritePaths: [`${project}/link/..`] });
		expect(widened.writePaths).toContain(outside);
		expect(widened.writePaths).not.toContain(workRoot);
		expect(isPathWritable(widened, join(workRoot, "sibling.txt"))).toBe(false);
		expect(isPathWritable(widened, join(outside, "sibling.txt"))).toBe(true);
	});

	it("relative '..' in extraWritePaths cannot silently reach an ancestor of the project", () => {
		const { policy } = policyFor({ extraWritePaths: ["../outside"] });

		expect(policy.writePaths).toContain(outside);
		expect(policy.writePaths).not.toContain(workRoot);
		expect(isPathWritable(policy, join(workRoot, "escape.txt"))).toBe(false);
	});

	it("places a not-yet-existing path under its resolved ancestor", () => {
		const { policy } = policyFor({ extraWritePaths: [`${project}/link/not-yet`] });

		expect(policy.writePaths).toContain(join(outsideSub, "not-yet"));
		expect(policy.writePaths).not.toContain(join(project, "link", "not-yet"));
	});

	it("rejects '..' below the deepest existing directory instead of guessing its target", () => {
		const escapeAttempt = `${project}/nope/../../escape`;
		const result = resolveRealPath(escapeAttempt, { base: project });
		expect(result.ok).toBe(false);

		const { policy, rejected } = policyFor({ extraWritePaths: [escapeAttempt] });
		expect(rejected.map((entry) => entry.input)).toEqual([escapeAttempt]);
		expect(rejected[0]?.reason).toContain("..");
		expect(policy.writePaths).not.toContain(join(workRoot, "escape"));
		expect(policy.writePaths).toContain(project);
	});

	it("rejects the filesystem root as an extra write path", () => {
		const { policy, rejected } = policyFor({ extraWritePaths: ["/"] });

		expect(rejected.map((entry) => entry.input)).toEqual(["/"]);
		expect(policy.writePaths).not.toContain("/");
		expect(policy.writePaths).toContain(project);
	});
});

describe("SandboxPolicy v1 defaults (R44-SBX.2)", () => {
	it("defaults to network on with cwd, session scratch and OS temp writable", () => {
		const { policy, rejected } = policyFor();

		expect(rejected).toEqual([]);
		expect(policy.version).toBe(1);
		expect(policy.network).toBe("on");
		expect(policy.read).toBe("allow-all");
		expect(policy.allowPrivilegeEscalation).toBe(false);
		expect(policy.writePaths).toEqual(expect.arrayContaining([project, scratch, fakeTmp]));

		expect(isPathWritable(policy, join(scratch, "a.txt"))).toBe(true);
		expect(isPathWritable(policy, join(fakeTmp, "a.txt"))).toBe(true);
		expect(isPathWritable(policy, join(fakeHome, ".ssh", "id_ed25519"))).toBe(false);
	});

	it("turns the network off through the single toggle", () => {
		expect(policyFor({ network: "off" }).policy.network).toBe("off");
	});

	it("grants only cache roots where tampering is detected, and none that carry executables", () => {
		const { policy } = policyFor({ includeDefaultCacheRoots: undefined });

		// What is left: content-addressed or checksum-verified download caches, where a
		// planted blob is either a cache miss or a hard error, plus npm's plain-text logs.
		for (const kept of [
			join(fakeHome, ".npm", "_cacache"),
			join(fakeHome, ".npm", "_logs"),
			join(fakeHome, ".pnpm-store"),
			join(fakeHome, ".yarn", "berry", "cache"),
			join(fakeHome, ".cargo", "registry"),
		]) {
			expect(policy.writePaths).toContain(kept);
		}

		// What is gone: every root that holds code a later *unsandboxed* program runs.
		// Writing to one of these is an escape by persistence, not a cache write.
		for (const escapeRoot of [
			join(fakeHome, ".cache"), // playwright browsers, pre-commit envs, uv/bazelisk toolchains
			join(fakeHome, "Library", "Caches"), // Sparkle update staging, Homebrew installers
			join(fakeHome, ".npm"), // _npx installs packages that npx then executes verbatim
			join(fakeHome, ".bun", "install", "cache"), // keyed by name@version, hard-linked, unverified
			join(fakeHome, ".yarn", "cache"),
			join(fakeHome, ".cargo", "git"), // build.rs from an unchecksummed git checkout
			join(fakeHome, "go", "pkg", "mod"), // go.sum is checked at download, not at build
			join(fakeHome, ".gradle", "caches"), // jars + compiled build scripts
			join(fakeHome, ".m2", "repository"), // jars; checksum verification is warn-only
		]) {
			expect(policy.writePaths).not.toContain(escapeRoot);
			expect(isPathWritable(policy, join(escapeRoot, "payload"))).toBe(false);
		}

		expect(policy.writePaths).not.toContain(fakeHome);
		expect(isPathWritable(policy, join(fakeHome, ".ssh", "id_ed25519"))).toBe(false);
	});

	it("collapses duplicate and nested write paths into a minimal sorted set", () => {
		const { policy } = policyFor({ extraWritePaths: [project, join(project, "nested", "deeper")] });

		expect(policy.writePaths.filter((path) => path === project)).toHaveLength(1);
		expect(policy.writePaths).not.toContain(join(project, "nested", "deeper"));
		expect([...policy.writePaths]).toEqual([...policy.writePaths].sort());
	});

	it("is a plain declarative value backends translate rather than extend", () => {
		const { policy } = policyFor();
		expect(Object.isFrozen(policy)).toBe(true);
		expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
	});
});

/**
 * D2: the write allowlist may not quietly become `$HOME`.
 *
 * `resolveSandboxPolicy` used to push `cwd` into the allowlist with no check at
 * all, so running the agent from `$HOME` (or `/Users`, or `/System/Volumes/Data`)
 * produced a policy whose allowlist *was* the home directory -- with no `rejected`
 * entry, no notice, and a backend still reporting `available`. That defeated the
 * very exclusions the curated cache-root list documents three lines above it.
 */
describe("excluded write roots (R44-SBX.2)", () => {
	it("refuses a cwd that is the home directory rather than silently making $HOME writable", () => {
		expect(() => policyFor({ cwd: fakeHome })).toThrow(SandboxPolicyError);
		expect(() => policyFor({ cwd: fakeHome })).toThrow(/home directory/);
	});

	it("refuses a cwd that contains the home directory (the `/Users` case)", () => {
		expect(() => policyFor({ cwd: workRoot })).toThrow(SandboxPolicyError);
		expect(() => policyFor({ cwd: workRoot })).toThrow(/contains the home directory/);
	});

	it("refuses the filesystem root as a cwd", () => {
		expect(() => policyFor({ cwd: "/" })).toThrow(SandboxPolicyError);
		expect(() => policyFor({ cwd: "/" })).toThrow(/filesystem root/);
	});

	it("applies the same exclusions to the scratch dir and the OS temp dir", () => {
		expect(() => policyFor({ sessionScratchDir: fakeHome })).toThrow(SandboxPolicyError);
		expect(() => policyFor({ tmpDir: fakeHome })).toThrow(SandboxPolicyError);
	});

	it("records an excluded extraWritePath as rejected and surfaces it, never silently", () => {
		const { policy, rejected } = policyFor({ extraWritePaths: [fakeHome] });

		expect(rejected.map((entry) => entry.input)).toEqual([fakeHome]);
		expect(rejected[0]?.reason).toContain("home directory");
		expect(policy.writePaths).not.toContain(fakeHome);
		expect(isPathWritable(policy, join(fakeHome, ".ssh", "id_ed25519"))).toBe(false);
		// The rest of the policy survives: narrowing, not refusing.
		expect(policy.writePaths).toContain(project);
	});

	it("still allows a project that merely lives inside the home directory", () => {
		const nested = join(fakeHome, "code", "app");
		mkdirSync(nested, { recursive: true });
		const { policy, rejected } = policyFor({ cwd: nested });

		expect(rejected).toEqual([]);
		expect(policy.writePaths).toContain(nested);
		expect(isPathWritable(policy, join(nested, "src", "index.ts"))).toBe(true);
		expect(isPathWritable(policy, join(fakeHome, ".ssh", "id_ed25519"))).toBe(false);
	});
});

/**
 * macOS firmlinks make `/System/Volumes/Data/Users/alice` and `/Users/alice` the
 * same directory while `realpath` keeps both spellings, so a purely lexical check
 * against `$HOME` misses one of them. Only meaningful where that firmlink exists.
 */
const dataVolumeHome = join("/System/Volumes/Data", realpathSync(homedir()));
describe.skipIf(process.platform !== "darwin" || !existsSync(dataVolumeHome))("macOS data-volume aliases", () => {
	const realHome = realpathSync(homedir());

	it("excludes the data-volume root, which aliases the whole filesystem", () => {
		expect(excludedWriteRootReason("/System/Volumes/Data", realHome, "darwin")).toBeTruthy();
		expect(excludedWriteRootReason("/System/Volumes", realHome, "darwin")).toBeTruthy();
	});

	it("excludes the home directory reached through the data volume, which realpath does not normalise", () => {
		// The premise: this spelling really is realpath-stable, so a string compare fails.
		expect(realpathSync.native(dataVolumeHome)).toBe(dataVolumeHome);
		expect(dataVolumeHome).not.toBe(realHome);

		expect(excludedWriteRootReason(dataVolumeHome, realHome, "darwin")).toBeTruthy();
	});

	it("leaves an ordinary project directory alone", () => {
		expect(excludedWriteRootReason(project, realHome, "darwin")).toBeNull();
	});
});

describe("SandboxExecutor status (R44-SBX.1)", () => {
	it("reports unavailable with a reason on an unsupported platform, without throwing", async () => {
		const executor = createSandboxExecutor({ platform: "win32" });
		const status = await executor.status();

		expect(status.available).toBe(false);
		expect(status.available === false && status.reason).toContain("win32");
	});

	it("refuses to execute when unavailable rather than running unconfined", async () => {
		const executor = createSandboxExecutor({ platform: "win32" });
		const { policy } = policyFor();

		await expect(executor.exec("echo hi", project, policy, { onData: () => {} })).rejects.toBeInstanceOf(
			SandboxUnavailableError,
		);
	});

	it("reports unavailable on a supported platform with no backend registered", async () => {
		const executor = createSandboxExecutor({ platform: "darwin", backends: [] });
		const status = await executor.status();

		expect(status.available).toBe(false);
		expect(status.available === false && status.reason).toContain("darwin");
	});

	it("selects the backend registered for the current platform", async () => {
		const backend: SandboxExecutor = {
			name: "fake",
			status: async () => ({ available: true }),
			exec: async () => ({ exitCode: 0 }),
		};
		const executor = createSandboxExecutor({
			platform: "linux",
			backends: [
				{ platform: "darwin", create: () => ({ ...backend, name: "wrong" }) },
				{ platform: "linux", create: () => backend },
			],
		});

		expect(executor.name).toBe("fake");
		expect(await executor.status()).toEqual({ available: true });
	});
});
