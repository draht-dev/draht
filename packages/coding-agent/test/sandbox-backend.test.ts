import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildLinuxSandboxCommand,
	buildSandboxEnv,
	buildSandboxExecArgs,
	buildSeatbeltProfile,
	createLinuxSandboxExecutor,
	createSeatbeltSandboxExecutor,
	detectLinuxSandboxMechanism,
	MAX_INLINE_PROFILE_BYTES,
	resolveSandboxPolicy,
	SANDBOX_ENV_ALLOWLIST,
	type SandboxPolicy,
	SandboxProfileError,
	SandboxUnavailableError,
	supportsLandlock,
} from "../src/core/sandbox/index.ts";

const isDarwin = process.platform === "darwin";

let workRoot: string;
let project: string;
let outside: string;
let fakeTmp: string;
let fakeHome: string;

beforeAll(() => {
	workRoot = realpathSync(mkdtempSync(join(tmpdir(), "draht-sandbox-backend-")));
	project = join(workRoot, "project");
	outside = join(workRoot, "outside");
	fakeTmp = join(workRoot, "tmp");
	fakeHome = join(workRoot, "home");
	for (const dir of [project, outside, fakeTmp, fakeHome]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
	rmSync(workRoot, { recursive: true, force: true });
});

function policy(overrides: Partial<Parameters<typeof resolveSandboxPolicy>[0]> = {}): SandboxPolicy {
	return resolveSandboxPolicy({
		cwd: project,
		tmpDir: fakeTmp,
		homeDir: fakeHome,
		includeDefaultCacheRoots: false,
		...overrides,
	}).policy;
}

/** Runs a command through an executor, collecting the combined output stream. */
async function run(
	executor: { exec: (c: string, cwd: string, p: SandboxPolicy, o: never) => Promise<{ exitCode: number | null }> },
	command: string,
	p: SandboxPolicy = policy(),
	env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string }> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString();
	};
	// Seconds. Generous on purpose: these tests assert *what* the sandbox permits,
	// and a loaded machine must not turn that into a stopwatch reading.
	const options = { onData, env, timeout: 120 };
	const { exitCode } = await executor.exec(command, project, p, options as never);
	return { exitCode, output };
}

// ---------------------------------------------------------------------------
// Profile generation (platform-independent -- pure string building)
// ---------------------------------------------------------------------------

describe("buildSeatbeltProfile", () => {
	it("renders every write path as a subpath rule and nothing else as writable", () => {
		const profile = buildSeatbeltProfile(policy());
		expect(profile).toContain(`(subpath "${project}")`);
		expect(profile).toContain(`(subpath "${fakeTmp}")`);
		expect(profile).not.toContain(`(subpath "${outside}")`);
	});

	// The profile is an allow-list. `(allow default)` is not a rule that can be
	// tightened later by adding denies -- it is the absence of a sandbox for every
	// capability nobody happened to think of, which is how mach-lookup (launchd)
	// and mach-priv-task-port (ptrace) stayed open through Phase 44's six passing
	// acceptance vectors.
	it("denies by default and never emits an allow-default rule", () => {
		for (const network of ["on", "off"] as const) {
			const profile = buildSeatbeltProfile(policy({ network }));
			expect(profile).toContain("(deny default)");
			expect(profile).not.toMatch(/^\(allow default\)/m);
		}
	});

	it("names the one mach service it needs instead of granting mach-lookup wholesale", () => {
		const profile = buildSeatbeltProfile(policy());
		// A bare `(allow mach-lookup)` is what puts LaunchServices -- and therefore
		// launchd, and therefore arbitrary unsandboxed execution -- back in reach.
		expect(profile).not.toMatch(/^\(allow mach-lookup\)$/m);
		expect(profile).toContain('(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))');
	});

	it("states the escape routes it forbids, rather than relying on deny-default alone", () => {
		const profile = buildSeatbeltProfile(policy());
		for (const rule of [
			"(deny mach-priv-task-port)", // task_for_pid / debugger attach
			"(deny mach-priv-host-port)",
			"(deny mach-task-name)",
			"(deny process-info* (target others))",
			"(deny job-creation)", // launchd spawning a job outside the sandbox
			"(deny lsopen)", // LaunchServices doing the same
			"(deny appleevent-send)", // scripting an unsandboxed app into doing it
			"(deny authorization-right-obtain)",
			"(deny file-write-setugid)",
		]) {
			expect(profile).toContain(rule);
		}
	});

	it("grants only the pty the command allocates for itself", () => {
		const profile = buildSeatbeltProfile(policy());
		// The Phase 44 rule was a bare `(regex #"^/dev/ttys[0-9]*$")` in the device
		// write list, which is every pty on the machine. The replacement is gated on
		// the sandbox extension `pseudo-tty` issues for the process's own pty.
		expect(profile).toContain("(allow pseudo-tty)");
		expect(profile).toContain('(require-all (regex #"^/dev/ttys[0-9]*$") (extension "com.apple.sandbox.pty"))');
		const deviceWriteLine = profile.split("\n").find((line) => line.includes('(literal "/dev/ptmx")')) ?? "";
		expect(deviceWriteLine).not.toContain("/dev/ttys");
	});

	it("confines unix-domain sockets to the write allowlist when network is on", () => {
		const profile = buildSeatbeltProfile(policy({ network: "on" }));
		expect(profile).toContain("(allow network-outbound (remote ip))");
		// The resolver socket is named exactly; nothing else outside the allowlist is.
		expect(profile).toContain('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
		expect(profile).toContain(`(allow network-outbound network-bind (subpath "${project}")`);
		expect(profile).not.toMatch(/^\(allow network\*\)$/m);
	});

	it("cuts unix-domain sockets too when the network is off", () => {
		const profile = buildSeatbeltProfile(policy({ network: "off" }));
		expect(profile).toContain("(deny network*)");
		// Nothing may re-open a socket after the blanket deny -- later rules win in SBPL.
		const afterDeny = profile.slice(profile.indexOf("(deny network*)"));
		expect(afterDeny).not.toContain("(allow network");
	});

	it("keeps reads unrestricted and stays silent about network when network is on", () => {
		const profile = buildSeatbeltProfile(policy({ network: "on" }));
		expect(profile).toContain("(allow file-read*)");
		expect(profile).not.toContain("(deny network*)");
	});

	it("denies network when the policy turns it off", () => {
		expect(buildSeatbeltProfile(policy({ network: "off" }))).toContain("(deny network*)");
	});

	it("refuses a write path that could break out of an SBPL string literal", () => {
		const hostile: SandboxPolicy = {
			version: 1,
			writePaths: ['/tmp/a")\n(allow default)(x "'],
			read: "allow-all",
			network: "on",
			allowPrivilegeEscalation: false,
		};
		expect(() => buildSeatbeltProfile(hostile)).toThrow(SandboxProfileError);
	});

	it("escapes a backslash rather than emitting it raw", () => {
		const odd: SandboxPolicy = {
			version: 1,
			writePaths: ["/tmp/back\\slash"],
			read: "allow-all",
			network: "on",
			allowPrivilegeEscalation: false,
		};
		expect(buildSeatbeltProfile(odd)).toContain('(subpath "/tmp/back\\\\slash")');
	});

	it("refuses to generate a profile for an empty write allowlist", () => {
		const empty: SandboxPolicy = {
			version: 1,
			writePaths: [],
			read: "allow-all",
			network: "on",
			allowPrivilegeEscalation: false,
		};
		expect(() => buildSeatbeltProfile(empty)).toThrow(SandboxProfileError);
	});
});

// ---------------------------------------------------------------------------
// Environment hygiene -- R44-SBX.5 (platform-independent)
// ---------------------------------------------------------------------------

describe("buildSandboxEnv", () => {
	it("constructs the env from an allowlist instead of copying the parent", () => {
		const env = buildSandboxEnv({
			source: { PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "leak", ANTHROPIC_API_KEY: "leak", HOME: "/home/x" },
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/x");
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("marks the child as sandboxed", () => {
		expect(buildSandboxEnv({ source: {} }).DRAHT_SANDBOX).toBe("1");
	});

	it("never carries a variable that is absent from the source", () => {
		expect("TERM" in buildSandboxEnv({ source: { PATH: "/usr/bin" } })).toBe(false);
	});

	it("admits explicitly configured extra names, and only those", () => {
		const env = buildSandboxEnv({ source: { CI: "1", SECRET: "s" }, extraAllowedNames: ["CI"] });
		expect(env.CI).toBe("1");
		expect(env.SECRET).toBeUndefined();
	});

	it("does not pass credential-agent handles by default", () => {
		expect(SANDBOX_ENV_ALLOWLIST).not.toContain("SSH_AUTH_SOCK");
		expect(SANDBOX_ENV_ALLOWLIST).not.toContain("GITHUB_TOKEN");
	});
});

// ---------------------------------------------------------------------------
// Linux command construction -- source-only evidence, NOT executed here
// ---------------------------------------------------------------------------

describe("buildLinuxSandboxCommand (source-only: never executed on darwin)", () => {
	it("binds the root read-only and each write path read-write under bwrap", () => {
		const built = buildLinuxSandboxCommand(
			{ kind: "bwrap", bin: "/usr/bin/bwrap" },
			policy(),
			"echo hi",
			{ shell: "/bin/bash", args: ["-c"] },
			project,
		);
		expect(built.command).toBe("/usr/bin/bwrap");
		const args = built.args.join(" ");
		expect(args).toContain("--ro-bind / /");
		expect(args).toContain(`--bind ${project} ${project}`);
		expect(args).not.toContain("--unshare-net");
		expect(built.args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
	});

	it("unshares the network namespace only when the policy turns network off", () => {
		const built = buildLinuxSandboxCommand(
			{ kind: "bwrap", bin: "/usr/bin/bwrap" },
			policy({ network: "off" }),
			"echo hi",
			{ shell: "/bin/bash", args: ["-c"] },
			project,
		);
		expect(built.args).toContain("--unshare-net");
	});

	it("remounts the root read-only inside the unshare fallback", () => {
		const built = buildLinuxSandboxCommand(
			{ kind: "unshare", bin: "/usr/bin/unshare" },
			policy(),
			"echo hi",
			{ shell: "/bin/bash", args: ["-c"] },
			project,
		);
		expect(built.command).toBe("/usr/bin/unshare");
		expect(built.args).toContain("--mount");
		expect(built.args.join(" ")).toContain("remount");
	});

	it("reports unavailable on linux when no mechanism is present, and never runs the command", async () => {
		const executor = createLinuxSandboxExecutor({ lookupBin: () => null, kernelRelease: "6.8.0" });
		const status = await executor.status();
		expect(status.available).toBe(false);
		await expect(executor.exec("echo hi", project, policy(), { onData: () => {} })).rejects.toBeInstanceOf(
			SandboxUnavailableError,
		);
	});
});

describe("detectLinuxSandboxMechanism (the exported entry point, not just the internal call)", () => {
	// Detection only asks `existsSync` of the helper, so any real file stands in for one.
	const helper = fileURLToPath(import.meta.url);
	const lookupBin = () => "/usr/bin/bwrap";

	it("defaults kernelRelease to os.release() instead of the empty string", () => {
		const withDefault = detectLinuxSandboxMechanism({ landlockHelperBin: helper, lookupBin });
		const explicit = detectLinuxSandboxMechanism({
			landlockHelperBin: helper,
			lookupBin,
			kernelRelease: osRelease(),
		});

		expect(withDefault).toEqual(explicit);
	});

	it("selects the Landlock helper on a supporting kernel rather than silently reporting bwrap", () => {
		// The defect: `options.kernelRelease ?? ""` made `supportsLandlock("")` false for
		// every exported call, so the most precise mechanism was never chosen.
		expect(supportsLandlock(osRelease())).toBe(true);
		expect(detectLinuxSandboxMechanism({ landlockHelperBin: helper, lookupBin })).toEqual({
			kind: "landlock",
			bin: helper,
		});
	});

	it("still falls back to bwrap when the kernel is too old for Landlock", () => {
		expect(detectLinuxSandboxMechanism({ landlockHelperBin: helper, lookupBin, kernelRelease: "5.12.0" })).toEqual({
			kind: "bwrap",
			bin: "/usr/bin/bwrap",
		});
	});
});

// ---------------------------------------------------------------------------
// macOS Seatbelt -- REAL execution against /usr/bin/sandbox-exec
// ---------------------------------------------------------------------------

describe.skipIf(!isDarwin)("seatbelt backend (real sandbox-exec on macOS)", () => {
	it("passes its self-test and reports available", async () => {
		const executor = createSeatbeltSandboxExecutor();
		expect(await executor.status()).toEqual({ available: true });
		expect(executor.name).toBe("seatbelt");
	});

	it("blocks a write outside the allowlist and allows one inside it", async () => {
		const executor = createSeatbeltSandboxExecutor();
		const escapeFile = join(outside, "escaped.txt");
		const allowed = join(project, "allowed.txt");
		const blocked = await run(executor, `echo bad > ${JSON.stringify(escapeFile)}`);
		expect(blocked.exitCode).not.toBe(0);
		expect(existsSync(escapeFile)).toBe(false);
		const ok = await run(executor, `echo good > ${JSON.stringify(allowed)}`);
		expect(ok.exitCode).toBe(0);
		expect(readFileSync(allowed, "utf8").trim()).toBe("good");
	});

	it("blocks the same escape when it is laundered through an interpreter", async () => {
		const executor = createSeatbeltSandboxExecutor();
		const escapeFile = join(outside, "via-python.txt");
		const result = await run(executor, `python3 -c "open(${JSON.stringify(escapeFile)},'w').write('x')"`);
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(escapeFile)).toBe(false);
	});

	it("does not hand the child a secret that only the parent knows", async () => {
		const executor = createSeatbeltSandboxExecutor();
		const parentEnv = { ...process.env, DRAHT_TEST_PARENT_ONLY_MARKER: "must-not-leak" };
		const result = await run(executor, "env", policy(), parentEnv);
		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("must-not-leak");
		expect(result.output).not.toContain("DRAHT_TEST_PARENT_ONLY_MARKER");
		expect(result.output).toContain("DRAHT_SANDBOX=1");
	});

	it("blocks a loopback connection when the policy turns network off", async () => {
		const executor = createSeatbeltSandboxExecutor();
		let accepted = 0;
		const server: Server = createServer((socket: Socket) => {
			accepted += 1;
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const connect = `exec 3<>/dev/tcp/127.0.0.1/${port} && echo CONNECTED`;
			const off = await run(executor, connect, policy({ network: "off" }));
			expect(off.output).not.toContain("CONNECTED");
			expect(accepted).toBe(0);
			const on = await run(executor, connect, policy({ network: "on" }));
			expect(on.output).toContain("CONNECTED");
			expect(accepted).toBe(1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("reports unavailable for a corrupted profile and refuses to run the command at all", async () => {
		const marker = join(outside, "corrupt-must-not-run.txt");
		const executor = createSeatbeltSandboxExecutor({
			buildProfile: () => "(version 1)\n(allow default\n",
		});
		const status = await executor.status();
		expect(status.available).toBe(false);
		if (!status.available) expect(status.reason).toMatch(/self-test/i);
		await expect(
			executor.exec(`echo ran > ${JSON.stringify(marker)}`, project, policy(), { onData: () => {} }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(existsSync(marker)).toBe(false);
	});

	it("reports unavailable for a profile that confines nothing, rather than trusting it", async () => {
		const marker = join(outside, "permissive-must-not-run.txt");
		const executor = createSeatbeltSandboxExecutor({ buildProfile: () => "(version 1)\n(allow default)\n" });
		const status = await executor.status();
		expect(status.available).toBe(false);
		await expect(
			executor.exec(`echo ran > ${JSON.stringify(marker)}`, project, policy(), { onData: () => {} }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(existsSync(marker)).toBe(false);
	});

	it("reports unavailable when sandbox-exec itself is missing instead of running bare", async () => {
		const marker = join(outside, "missing-bin-must-not-run.txt");
		const executor = createSeatbeltSandboxExecutor({ sandboxExecBin: join(workRoot, "no-such-sandbox-exec") });
		const status = await executor.status();
		expect(status.available).toBe(false);
		await expect(
			executor.exec(`echo ran > ${JSON.stringify(marker)}`, project, policy(), { onData: () => {} }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses a policy it cannot render, rather than running the command", async () => {
		const executor = createSeatbeltSandboxExecutor();
		const marker = join(outside, "unrenderable-must-not-run.txt");
		// A write allowlist containing the root confines nothing; policy resolution
		// rejects it as configuration, and profile generation refuses it again here
		// for a policy that reached the backend some other way (a cwd of `/`).
		const rootPolicy: SandboxPolicy = {
			version: 1,
			writePaths: ["/"],
			read: "allow-all",
			network: "on",
			allowPrivilegeEscalation: false,
		};
		await expect(
			executor.exec(`echo ran > ${JSON.stringify(marker)}`, project, rootPolicy, { onData: () => {} }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(existsSync(marker)).toBe(false);
	});

	it("cannot escalate privileges: exec of a setuid-root binary is refused", async () => {
		// The R44-SBX.2 invariant, as an escape attempt rather than a claim. `status()`
		// above already implies it -- the self-test now probes this before reporting
		// `available` -- but the attempt is spelled out here so a regression names itself.
		const executor = createSeatbeltSandboxExecutor();
		expect(existsSync("/usr/bin/sudo")).toBe(true);

		const branch = await run(
			executor,
			"if /usr/bin/sudo -n id -u > /dev/null 2>&1; then echo ESCALATED; else echo BLOCKED; fi",
		);
		expect(branch.output).toContain("BLOCKED");
		expect(branch.output).not.toContain("ESCALATED");

		// And the mechanism: the kernel refuses the *exec*, so it never got as far as
		// sudo deciding whether this user has rights.
		const direct = await run(executor, "/usr/bin/sudo -n true");
		expect(direct.exitCode).not.toBe(0);
		expect(direct.output).toMatch(/not permitted/i);
	});

	it("cannot be escaped by re-entering sandbox-exec with a permissive profile", async () => {
		const executor = createSeatbeltSandboxExecutor();
		const escapeFile = join(outside, "via-nested.txt");
		const permissive = join(workRoot, "permissive.sb");
		writeFileSync(permissive, "(version 1)\n(allow default)\n");
		const result = await run(
			executor,
			`/usr/bin/sandbox-exec -f ${JSON.stringify(permissive)} /bin/sh -c ${JSON.stringify(`echo esc > ${escapeFile}`)}`,
		);
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(escapeFile)).toBe(false);
	});

	it("is selected automatically on darwin by createSandboxExecutor", async () => {
		const { createSandboxExecutor } = await import("../src/core/sandbox/index.ts");
		const executor = createSandboxExecutor();
		expect(executor.name).toBe("seatbelt");
		expect(await executor.status()).toEqual({ available: true });
	});
});

// ---------------------------------------------------------------------------
// Escape vectors that Phase 44's `(allow default)` profile did not close.
//
// Each case below reproduces a real escape and then proves it blocked. The
// reproduction runs against `legacySeatbeltProfile` -- the exact Phase 44 shape,
// which *passes the R44-SBX.4 self-test* -- because that is the whole point: a
// sandbox can confine every write, cut the network on demand, satisfy six
// acceptance vectors, and still let a confined command run code outside itself.
//
// Where a vector depends on machine configuration (LaunchServices reachable, a
// debuggable process available, `lldb` installed) the test first checks that the
// escape works *unsandboxed*. If it does not, there was nothing for the sandbox
// to block and the case is skipped rather than passing vacuously.
// ---------------------------------------------------------------------------

/**
 * The Phase 44 profile, verbatim in shape: read allow-all, writes confined to
 * the allowlist, network toggled -- and `(allow default)` underneath all of it.
 */
function legacySeatbeltProfile(p: SandboxPolicy): string {
	const devices = [
		'(literal "/dev/null")',
		'(literal "/dev/zero")',
		'(literal "/dev/random")',
		'(literal "/dev/urandom")',
		'(literal "/dev/stdin")',
		'(literal "/dev/stdout")',
		'(literal "/dev/stderr")',
		'(literal "/dev/tty")',
		'(literal "/dev/ptmx")',
		'(subpath "/dev/fd")',
		'(regex #"^/dev/ttys[0-9]*$")',
	].join(" ");
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		"(allow file-read*)",
		...p.writePaths.map((path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`),
		`(allow file-write* ${devices})`,
		"(deny file-write-setugid)",
		p.network === "off" ? "(deny network*)" : "",
		"",
	].join("\n");
}

/**
 * Single-quoted shell word. `JSON.stringify` is not a shell quoter: a `\n` inside
 * a double-quoted bash word stays two literal characters, which silently turns
 * every multi-line `python3 -c` probe below into a syntax error rather than the
 * escape it is meant to attempt.
 */
function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Polls until `check` holds or `timeoutMs` elapses. Escapes via launchd are asynchronous. */
async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return check();
}

/**
 * A Python `multiprocessing.Pool`, the thing `(allow ipc-posix-sem)` is in the
 * profile for. It has to run from a file rather than `python3 -c`: with `-c` the
 * spawned workers cannot unpickle a function defined in `__main__`, which fails
 * identically outside any sandbox and would make this a test of CPython, not of
 * the profile.
 */
const MULTIPROCESSING_SNIPPET = [
	"import multiprocessing as m",
	"def double(x): return x * 2",
	'if __name__ == "__main__":',
	"    with m.Pool(2) as pool: print(pool.map(double, [1, 2]))",
].join("\n");

describe.skipIf(!isDarwin)("sandbox escape vectors (real sandbox-exec on macOS)", () => {
	// One executor each, so the R44-SBX.4 self-test runs twice for the whole block
	// rather than once per case. Both must report `available`: the legacy profile
	// passing its self-test is the premise of every reproduction below.
	const current = createSeatbeltSandboxExecutor();
	const legacy = createSeatbeltSandboxExecutor({ buildProfile: legacySeatbeltProfile });

	it("both the current and the legacy profile pass the self-test", async () => {
		expect(await current.status()).toEqual({ available: true });
		expect(await legacy.status()).toEqual({ available: true });
	});

	// -- D3: the profile file was staged where the sandbox could write it -------

	it("passes the profile inline, so there is no on-disk profile to tamper with", () => {
		const args = buildSandboxExecArgs("(version 1)\n(deny default)\n", "/bin/bash", ["-c"], "echo hi");
		expect(args[0]).toBe("-p");
		expect(args[1]).toContain("(deny default)");
		expect(args).not.toContain("-f");
		// No element may be a path to a profile: that path is the thing a sandboxed
		// command used to be able to overwrite between generation and use.
		expect(args.some((arg) => arg.endsWith(".sb"))).toBe(false);
	});

	it("would have staged the old profile inside its own write allowlist", () => {
		// The defect in one assertion. `os.tmpdir()` is in the write allowlist of
		// every production policy (R44-SBX.2), so `mkdtemp(os.tmpdir())/policy.sb`
		// -- where Phase 44 wrote the SBPL -- was writable by the very command that
		// SBPL was confining. The fix is not a better staging directory; it is not
		// having a file.
		const realTmp = realpathSync(tmpdir());
		const production = resolveSandboxPolicy({ cwd: project, homeDir: homedir() }).policy;
		expect(production.writePaths.some((path) => realTmp === path || realTmp.startsWith(`${path}/`))).toBe(true);
	});

	it("leaves no staged profile visible to the command it is confining", async () => {
		const realTmp = realpathSync(tmpdir());
		const marker = join(realTmp, `draht-sbx-d3-${process.pid}.txt`);
		try {
			const result = await run(
				current,
				`printf 'staged=%s\\n' "$(ls -d ${JSON.stringify(realTmp)}/draht-sbpl-* 2>/dev/null | wc -l | tr -d ' ')"; ` +
					`touch ${JSON.stringify(marker)} && echo writable=yes || echo writable=no`,
				policy({ tmpDir: realTmp, homeDir: homedir() }),
			);
			// Positive control: the old staging directory's parent really is writable
			// from inside the sandbox, which is what made staging there fatal.
			expect(result.output).toContain("writable=yes");
			// Negative control: while this very command runs, its own profile is not on
			// disk. Under Phase 44 the count here included its own `draht-sbpl-*` dir.
			expect(result.output).toContain("staged=0");
		} finally {
			rmSync(marker, { force: true });
		}
	});

	it("cannot be made permissive by a profile a previous command planted", async () => {
		const realTmp = realpathSync(tmpdir());
		const planted = join(realTmp, `draht-sbpl-planted-${process.pid}`);
		// Not the usual `outside`: this policy makes the whole OS temp dir writable
		// (as production does), and `outside` lives inside it. `/private/tmp` is a
		// different tree that no rule in this policy names.
		const escapeFile = join("/tmp", `draht-sbx-planted-${process.pid}.txt`);
		const confined = policy({ tmpDir: realTmp, homeDir: homedir() });
		try {
			// Command 1: plant `(allow default)` at the names the old implementation
			// used, and overwrite any real staged profile that happens to exist.
			await run(
				current,
				`mkdir -p ${JSON.stringify(planted)} && printf '(version 1)\\n(allow default)\\n' > ${JSON.stringify(
					join(planted, "policy.sb"),
				)} && for d in ${JSON.stringify(
					realTmp,
				)}/draht-sbpl-*; do [ -d "$d" ] && printf '(version 1)\\n(allow default)\\n' > "$d/policy.sb"; done; true`,
				confined,
			);
			// Command 2: still confined.
			const after = await run(current, `echo escaped > ${JSON.stringify(escapeFile)}`, confined);
			expect(after.exitCode).not.toBe(0);
			expect(existsSync(escapeFile)).toBe(false);
		} finally {
			rmSync(planted, { recursive: true, force: true });
			rmSync(escapeFile, { force: true });
		}
	});

	it("refuses a profile too large to pass inline, rather than letting execve fail opaquely", async () => {
		const marker = join(outside, "oversized-must-not-run.txt");
		const oversized = createSeatbeltSandboxExecutor({
			// Comment padding: valid SBPL, just too much of it to hand to `execve`.
			buildProfile: () => `(version 1)\n(deny default)\n${";; pad\n".repeat(MAX_INLINE_PROFILE_BYTES / 4)}`,
		});
		const status = await oversized.status();
		expect(status.available).toBe(false);
		await expect(
			oversized.exec(`echo ran > ${JSON.stringify(marker)}`, project, policy(), { onData: () => {} }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(existsSync(marker)).toBe(false);
	});

	// -- D1: launchd / LaunchServices -------------------------------------------

	it("cannot have LaunchServices start a program outside the sandbox", { timeout: 180_000 }, async (ctx) => {
		const bundle = join(workRoot, `Escape-${process.pid}.app`);
		const escapeFile = join(outside, "via-launchservices.txt");
		mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
		writeFileSync(
			join(bundle, "Contents", "Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Escape</string>
<key>CFBundleIdentifier</key><string>tech.fr3n.draht.sandbox-escape-probe.p${process.pid}</string>
<key>CFBundleName</key><string>Escape</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
		);
		writeFileSync(
			join(bundle, "Contents", "MacOS", "Escape"),
			`#!/bin/sh\necho escaped-via-launchservices > ${JSON.stringify(escapeFile)}\n`,
			{ mode: 0o755 },
		);
		const openCommand = `/usr/bin/open -a ${JSON.stringify(bundle)}`;
		rmSync(escapeFile, { force: true });

		// Reproduction: under the Phase 44 profile the sandboxed `open` hands the
		// launch to LaunchServices, launchd starts the program *outside* the sandbox,
		// and it writes where the write allowlist says nothing may be written.
		await run(legacy, openCommand);
		if (!(await waitUntil(() => existsSync(escapeFile)))) {
			ctx.skip(); // LaunchServices is not reachable here; nothing to have blocked.
			return;
		}
		rmSync(escapeFile, { force: true });

		// Blocked: the current profile names the one mach service it needs, so `open`
		// cannot reach LaunchServices at all.
		const result = await run(current, openCommand);
		expect(result.exitCode).not.toBe(0);
		expect(await waitUntil(() => existsSync(escapeFile), 6_000)).toBe(false);
	});

	// -- D2: debugger attach to an unsandboxed process --------------------------

	it("cannot attach a debugger to an unsandboxed process and run code in it", { timeout: 180_000 }, async (ctx) => {
		const victimBin = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find((bin) => existsSync(bin));
		if (!existsSync("/usr/bin/lldb") || !victimBin) {
			ctx.skip(); // No debugger, or no non-hardened same-uid process to attach to.
			return;
		}
		const { execFile, spawn } = await import("node:child_process");
		const escapeFile = join(outside, "via-debugger.txt");
		const controlFile = join(outside, "via-debugger-control.txt");

		/** Starts a victim, attaches to it, waits for the payload, and reaps it. */
		const attack = async (target: string, attach: (command: string) => Promise<unknown>): Promise<void> => {
			rmSync(target, { force: true });
			const victim = spawn(victimBin, ["-c", "import time; time.sleep(45)"], { stdio: "ignore" });
			try {
				await new Promise((resolve) => setTimeout(resolve, 800));
				if (!victim.pid) return;
				await attach(
					`/usr/bin/lldb -p ${victim.pid} -b -o ${JSON.stringify(
						`expr (int)system("echo owned > ${target}")`,
					)} -o detach -o quit`,
				);
				await waitUntil(() => existsSync(target), 10_000);
			} finally {
				victim.kill("SIGKILL");
			}
		};

		// Does this machine permit the attach at all (SIP, taskgated, entitlements)?
		await attack(
			controlFile,
			(command) =>
				new Promise((resolve) => {
					execFile("/bin/bash", ["-c", command], () => resolve(undefined));
				}),
		);
		if (!existsSync(controlFile)) {
			ctx.skip();
			return;
		}
		rmSync(controlFile, { force: true });

		// Reproduction: `(allow default)` leaves `mach-priv-task-port` open, so the
		// confined command takes the task port of an unsandboxed process and runs a
		// shell command inside it -- which writes outside the write allowlist.
		await attack(escapeFile, (command) => run(legacy, command));
		expect(existsSync(escapeFile)).toBe(true);

		// Blocked: `(deny default)` plus an explicit `(deny mach-priv-task-port)`.
		await attack(escapeFile, (command) => run(current, command));
		expect(existsSync(escapeFile)).toBe(false);
	});

	// -- D4: unix-domain sockets ------------------------------------------------

	it("cannot reach the unix socket of an unsandboxed daemon", { timeout: 120_000 }, async () => {
		const { createServer: createUnixServer } = await import("node:net");
		// A short path: AF_UNIX addresses are capped near 104 bytes and the test's
		// own tmpdir is already long. Deliberately outside the write allowlist.
		const socketPath = join("/tmp", `draht-sbx-d4-${process.pid}.sock`);
		const received: string[] = [];
		rmSync(socketPath, { force: true });
		const daemon = createUnixServer((socket) => {
			socket.on("data", (chunk) => received.push(chunk.toString()));
		});
		await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
		const inject = (marker: string) =>
			`python3 -c ${shq(
				[
					"import socket",
					"s = socket.socket(socket.AF_UNIX)",
					`s.connect(${JSON.stringify(socketPath)})`,
					`s.sendall(b${JSON.stringify(marker)})`,
					'print("connected")',
				].join("\n"),
			)}`;
		try {
			// Reproduction: with the default `network: "on"`, the Phase 44 profile let a
			// confined command drive a daemon that is not confined at all.
			const escaped = await run(legacy, inject("legacy"));
			expect(escaped.output).toContain("connected");
			expect(await waitUntil(() => received.includes("legacy"), 10_000)).toBe(true);

			// Blocked: unix sockets are granted only under the write allowlist.
			const blocked = await run(current, inject("current"));
			expect(blocked.exitCode).not.toBe(0);
			expect(await waitUntil(() => received.includes("current"), 6_000)).toBe(false);
		} finally {
			await new Promise<void>((resolve) => daemon.close(() => resolve()));
			rmSync(socketPath, { force: true });
		}
	});

	it("still lets a command use a unix socket inside its own writable area", async () => {
		// The narrowing must not take local IPC away from the command itself.
		const shortProject = realpathSync(mkdtempSync(join("/tmp", "draht-sbx-ux-")));
		try {
			const localPolicy = resolveSandboxPolicy({
				cwd: shortProject,
				tmpDir: fakeTmp,
				homeDir: fakeHome,
				includeDefaultCacheRoots: false,
			}).policy;
			const script = [
				"import socket, os",
				`p = os.path.join(${JSON.stringify(shortProject)}, "s.sock")`,
				"srv = socket.socket(socket.AF_UNIX)",
				"srv.bind(p)",
				"srv.listen(1)",
				"cli = socket.socket(socket.AF_UNIX)",
				"cli.connect(p)",
				'print("local-ipc-ok")',
			].join("\n");
			let output = "";
			const { exitCode } = await current.exec(`python3 -c ${shq(script)}`, shortProject, localPolicy, {
				onData: (data) => {
					output += data.toString();
				},
				timeout: 30,
			});
			expect(output).toContain("local-ipc-ok");
			expect(exitCode).toBe(0);
		} finally {
			rmSync(shortProject, { recursive: true, force: true });
		}
	});

	// -- D5: writing into somebody else's terminal ------------------------------

	it("cannot write into a pty it does not own", { timeout: 120_000 }, async () => {
		const { spawn } = await import("node:child_process");
		const seen = join(outside, "pty-victim-saw.txt");
		rmSync(seen, { force: true });
		// A pty allocated from *outside* the sandbox, standing in for the user's own
		// terminal. The helper reports what actually arrives on the master end, so a
		// successful spoof is observed rather than inferred from an exit code.
		const helper = spawn(
			"/usr/bin/python3",
			[
				"-c",
				[
					"import pty, os, sys",
					"m, s = pty.openpty()",
					"sys.stdout.write(os.ttyname(s) + chr(10))",
					"sys.stdout.flush()",
					`sink = open(${JSON.stringify(seen)}, "ab", buffering=0)`,
					"while True:",
					"    sink.write(os.read(m, 200))",
				].join("\n"),
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			const slaveName = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("pty helper did not report a tty")), 10_000);
				helper.stdout?.once("data", (chunk: Buffer) => {
					clearTimeout(timer);
					resolve(chunk.toString().trim());
				});
			});
			expect(slaveName).toMatch(/^\/dev\/ttys\d+$/);
			const spoof = `echo SPOOFED-PROMPT > ${JSON.stringify(slaveName)}`;

			// Reproduction: the Phase 44 device list granted `^/dev/ttys[0-9]*$`, i.e.
			// every pty on the machine, so the forged line reached a foreign terminal.
			const escaped = await run(legacy, spoof);
			expect(escaped.exitCode).toBe(0);
			expect(
				await waitUntil(() => existsSync(seen) && readFileSync(seen, "utf8").includes("SPOOFED-PROMPT"), 10_000),
			).toBe(true);
			rmSync(seen, { force: true });

			// Blocked: only the pty this process allocated via `pseudo-tty` is writable.
			const blocked = await run(current, spoof);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.output).toMatch(/Operation not permitted|Permission denied/);
			expect(await waitUntil(() => existsSync(seen), 6_000)).toBe(false);
		} finally {
			helper.kill("SIGKILL");
			rmSync(seen, { force: true });
		}
	});

	it("still lets a command use a pty it allocated itself", async () => {
		const script = [
			"import pty, os",
			"m, s = pty.openpty()",
			'os.write(s, b"x")',
			'print("own-pty-ok", os.read(m, 1))',
		].join("\n");
		const result = await run(current, `python3 -c ${shq(script)}`);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("own-pty-ok");
	});

	// -- signalling out of the sandbox ------------------------------------------

	it("cannot signal a process outside the sandbox, but can manage its own tree", async () => {
		const { spawn } = await import("node:child_process");
		const victim = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(victim.pid).toBeTruthy();
			const killed = await run(current, `kill -TERM ${victim.pid}`);
			expect(killed.exitCode).not.toBe(0);
			expect(victim.exitCode).toBeNull();
			const own = await run(current, "sleep 20 & p=$!; kill $p; wait $p 2>/dev/null; echo own-job-control-ok");
			expect(own.output).toContain("own-job-control-ok");
		} finally {
			victim.kill("SIGKILL");
		}
	});

	// -- the allow-list must not have broken real toolchains --------------------

	// Generous: eight real spawns through `sandbox-exec`, each starting an
	// interpreter or a toolchain binary cold.
	it("still runs the toolchains the allow-list was enumerated against", { timeout: 120_000 }, async () => {
		const multiprocessingProbe = join(project, "multiprocessing-probe.py");
		writeFileSync(multiprocessingProbe, `${MULTIPROCESSING_SNIPPET}\n`);
		const checks: Array<[string, string]> = [
			["bash", "echo bash-ok"],
			["user lookup", 'test "$(id -un)" != "$(id -u)" && echo id-ok'],
			["python3", `python3 -c ${shq('import ssl, json, sqlite3; print("python-ok")')}`],
			["python multiprocessing", `python3 ${JSON.stringify(multiprocessingProbe)}`],
			["node", `${JSON.stringify(process.execPath)} -e "console.log('node-ok', require('os').cpus().length > 0)"`],
			["git", "git --version > /dev/null && echo git-ok"],
			["pipes and subshells", "echo a | grep a | wc -l > /dev/null && echo pipe-ok"],
			["writes inside the allowlist", `echo ok > ${JSON.stringify(join(project, "allowlist-write.txt"))}`],
		];
		for (const [name, command] of checks) {
			const result = await run(current, command);
			expect(result.exitCode, `${name} failed: ${result.output}`).toBe(0);
		}
	});
});
