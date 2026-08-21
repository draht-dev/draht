/**
 * Startup self-test (R44-SBX.4) -- the only thing that may report `available`.
 *
 * Phase 28 established the pattern: prove the sandbox holds before trusting it
 * (`packages/rlm/src/session.ts` sends a `self_test` message and refuses the
 * session unless the driver reports network and file reads actually blocked).
 * This is the same idea applied to a shell backend, with one addition that
 * turned out to matter more than the original probe.
 *
 * ## Why the probe is two-sided
 *
 * The obvious self-test -- "try to write outside the allowlist, expect failure"
 * -- passes for the *worst possible* backend. Measured on macOS: a profile with
 * a syntax error makes `sandbox-exec` exit 65 **without ever running the
 * command**. The write does not happen, no file appears, and a one-sided probe
 * concludes "confined" about a backend that cannot confine anything. It would
 * then report `available`, and every downstream permission decision would
 * inherit that lie -- precisely the failure this requirement exists to prevent.
 *
 * So every probe carries a positive control as well as a negative one:
 *
 * | control  | probe                            | proves                          |
 * |----------|----------------------------------|---------------------------------|
 * | positive | write *inside* the allowlist     | the sandbox ran the command     |
 * | negative | write *outside* the allowlist    | writes are actually confined    |
 * | positive | loopback connect, network **on** | the network probe can connect   |
 * | negative | loopback connect, network **off**| the network is actually cut     |
 * | negative | exec a setuid-root binary        | privileges cannot be acquired   |
 *
 * A broken profile fails the positive controls. An over-permissive profile
 * (`(allow default)` and nothing else) fails the negative ones. Both answer
 * `unavailable`. There is no third outcome.
 *
 * ## The privilege-escalation probe, and what it is actually worth
 *
 * `SandboxPolicy.allowPrivilegeEscalation` is typed as the literal `false`
 * precisely because it is an invariant no caller may widen -- yet the self-test
 * used to grant `available` without testing it at all, and `linux.ts` leans on
 * this self-test as its entire safety argument. So the probe now attempts the
 * escalation from inside the throwaway sandbox and reports two facts:
 *
 * - **`privilegeEscalation`** -- it locates a setuid-root binary on the host
 *   (`sudo`, then `su`) and executes it. Three outcomes matter:
 *   `escalated:*` (it acquired uid 0 -- an outright failure), `exec-refused:*`
 *   (the kernel refused to `exec` a setuid binary from inside the sandbox), and
 *   `ran:*` (it executed but did not acquire privileges).
 * - **`noNewPrivs`** -- on Linux, `NoNewPrivs` from `/proc/self/status`. `1` is
 *   the kernel's own guarantee that no `exec` can gain privileges, which is
 *   exactly the mechanism `linux.ts` claims bubblewrap gives it (and that
 *   Landlock requires); `not-linux` elsewhere.
 *
 * The verdict is fail-closed and requires *evidence*, not absence of failure:
 * `escalated:*` and `NoNewPrivs: 0` are failures, and a pass needs either
 * `exec-refused:*` or `NoNewPrivs: 1`. A bare `ran:*` is deliberately **not**
 * enough -- on a host where the user simply has no `sudo` rights, an entirely
 * unconfined process produces the same `ran:*`, which is the one-sided-probe
 * mistake this module already refuses to make elsewhere.
 *
 * Measured on macOS 25.5: `exec` of `/usr/bin/sudo` from inside *any* seatbelt
 * sandbox fails `EPERM` (`exec-refused:EPERM`), while the same `exec` outside
 * one succeeds -- so on darwin the negative control has a real positive control
 * behind it. On Linux under bubblewrap the evidence is `NoNewPrivs: 1`; the
 * `unshare` fallback establishes neither and therefore reports `unavailable`,
 * which is the fail-closed reading of an invariant that backend cannot show it
 * holds.
 *
 * ## Evidence comes from outside the sandbox
 *
 * The probe reports what it observed, but the probe runs inside the thing under
 * test, so its word alone is not evidence. Every negative control is confirmed
 * from the parent: the file the probe was told to create must not exist on disk
 * afterwards, and the loopback listener -- a real server in this process -- must
 * not have accepted a connection. A backend that lets a write through but
 * garbles its own stderr still fails.
 *
 * ## Why network is probed even for a network-on session
 *
 * The self-test runs once per backend instance and covers both axes, so the
 * cached answer is valid for any policy the session later uses. If network-off
 * enforcement is broken while write confinement works, the backend reports
 * `unavailable` even for sessions that would have run with network on. That is
 * deliberately conservative: `available` is a claim about the backend, and half
 * a backend is not one.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxStatus } from "./executor.ts";
import { SANDBOX_POLICY_VERSION, type SandboxPolicy } from "./policy.ts";
import { resolveRealPath } from "./real-path.ts";

/** Prefixes the probe's single result line so it survives interleaved tool output. */
const PROBE_MARKER = "__DRAHT_SANDBOX_PROBE__";

const PROBE_CONNECT_TIMEOUT_MS = 3_000;

/** Seconds. Generous: a cold `sandbox-exec` + node start on a loaded machine is still far under this. */
const DEFAULT_PROBE_TIMEOUT_SECONDS = 30;

/**
 * The probe. Written to disk outside the writable area (so reaching it also
 * exercises read allow-all) and run through the backend's real `exec` path --
 * same wrapper, same profile generation, same env -- because a self-test that
 * takes a different path than production tests a different thing.
 *
 * Node rather than shell built-ins: `process.execPath` is guaranteed present and
 * its behaviour does not vary with which `sh` the host resolved, so a "blocked"
 * verdict is never really "this shell has no `/dev/tcp`".
 */
const PROBE_SOURCE = `import { writeFileSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = {
	insideWrite: "not-attempted",
	outsideWrite: "not-attempted",
	loopback: "not-attempted",
	privilegeEscalation: "not-attempted",
	noNewPrivs: "not-attempted",
};

function attempt(file) {
	try {
		writeFileSync(file, "probe");
		return "wrote";
	} catch (err) {
		return "blocked:" + (err.code ?? err.message);
	}
}

/** Binaries whose whole purpose is to run as another user. Only ones we can invoke harmlessly. */
const SETUID_CANDIDATES = ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo", "/usr/bin/su", "/bin/su"];

function findSetuidRoot() {
	const found = [];
	for (const path of SETUID_CANDIDATES) {
		try {
			const stat = statSync(path);
			if (stat.uid === 0 && (stat.mode & 0o4000) !== 0) found.push(path);
		} catch {}
	}
	return found;
}

function attemptEscalation() {
	const found = findSetuidRoot();
	if (found.length === 0) return "no-setuid-root-binary";
	const sudo = found.find((path) => path.endsWith("/sudo"));
	const bin = sudo ?? found[0];
	// -n never prompts, so this cannot hang on a password. A printed uid of 0 means
	// the escalation actually happened, which is the thing being detected.
	const args = sudo ? ["-n", "id", "-u"] : ["--version"];
	let run;
	try {
		run = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return "attempt-failed:" + (err.code ?? err.message);
	}
	if (run.error) {
		const code = run.error.code ?? run.error.message;
		// EPERM/EACCES at exec time is the sandbox refusing to run a setuid binary.
		if (code === "EPERM" || code === "EACCES") return "exec-refused:" + code;
		return "attempt-failed:" + code;
	}
	if (sudo && run.status === 0 && (run.stdout ?? "").trim() === "0") return "escalated:euid=0";
	return "ran:" + bin + ":exit=" + run.status;
}

function readNoNewPrivs() {
	if (process.platform !== "linux") return "not-linux";
	try {
		const match = /^NoNewPrivs:\\s*(\\d+)/m.exec(readFileSync("/proc/self/status", "utf8"));
		return match ? match[1] : "unreported";
	} catch (err) {
		return "unreadable:" + (err.code ?? err.message);
	}
}

result.insideWrite = attempt(config.insideFile);
result.outsideWrite = attempt(config.outsideFile);
result.privilegeEscalation = attemptEscalation();
result.noNewPrivs = readNoNewPrivs();

result.loopback = await new Promise((resolve) => {
	const socket = connect({ host: "127.0.0.1", port: config.loopbackPort });
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(value);
	};
	socket.setTimeout(config.connectTimeoutMs, () => finish("blocked:ETIMEDOUT"));
	socket.once("connect", () => finish("connected"));
	socket.once("error", (err) => finish("blocked:" + (err.code ?? err.message)));
});

process.stdout.write("\\n" + config.marker + JSON.stringify(result) + "\\n");
`;

interface ProbeReport {
	insideWrite: string;
	outsideWrite: string;
	loopback: string;
	/** See the module doc: `escalated:*` / `exec-refused:*` / `ran:*` / `no-setuid-root-binary`. */
	privilegeEscalation?: string;
	/** Linux `/proc/self/status` `NoNewPrivs`, or `not-linux`. */
	noNewPrivs?: string;
}

/**
 * Runs one command through the backend under test and returns its exit code and
 * combined output. Backends pass their own `exec` here so the self-test and
 * production execution cannot drift apart.
 */
export type SandboxSelfTestRunner = (
	command: string,
	cwd: string,
	policy: SandboxPolicy,
	timeoutSeconds: number,
) => Promise<{ exitCode: number | null; output: string }>;

export interface SandboxSelfTestOptions {
	/** Backend name, used only to make the failure reason say who failed. */
	backendName: string;
	run: SandboxSelfTestRunner;
	/** Seconds. Defaults to 30. */
	timeoutSeconds?: number;
}

/** Single-quoted shell word: the only character needing care inside `'...'` is `'` itself. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function probePolicy(writeRoot: string, network: "on" | "off"): SandboxPolicy {
	return Object.freeze({
		version: SANDBOX_POLICY_VERSION,
		writePaths: Object.freeze([writeRoot]),
		read: "allow-all",
		network,
		allowPrivilegeEscalation: false,
	});
}

function parseReport(output: string): ProbeReport | null {
	const index = output.lastIndexOf(PROBE_MARKER);
	if (index === -1) return null;
	const line = output.slice(index + PROBE_MARKER.length).split("\n", 1)[0];
	try {
		const parsed = JSON.parse(line ?? "");
		if (parsed && typeof parsed === "object") return parsed as ProbeReport;
		return null;
	} catch {
		return null;
	}
}

function unavailable(backendName: string, detail: string): SandboxStatus {
	return { available: false, reason: `${backendName} sandbox self-test failed: ${detail}` };
}

/**
 * The `allowPrivilegeEscalation: false` invariant, checked against what the probe
 * actually observed. Returns the failure detail, or `null` when the invariant is
 * demonstrated. See the module doc for why `ran:*` on its own is not evidence.
 */
function privilegeEscalationFailure(report: ProbeReport): string | null {
	const escalation = report.privilegeEscalation;
	const noNewPrivs = report.noNewPrivs;
	if (escalation === undefined || noNewPrivs === undefined || escalation === "not-attempted") {
		// Positive control for this probe: an older or garbled probe that never ran
		// the escalation attempt must not be read as "escalation is impossible".
		return `the probe did not report a privilege-escalation attempt (privilegeEscalation: ${JSON.stringify(
			escalation,
		)}), so the allowPrivilegeEscalation invariant was not tested`;
	}
	if (escalation.startsWith("escalated")) {
		return `a setuid-root binary acquired privileges inside the sandbox (${escalation}), so the allowPrivilegeEscalation invariant does not hold`;
	}
	if (noNewPrivs === "0") {
		return "the kernel reports NoNewPrivs: 0 inside the sandbox, so an exec can still gain privileges through a setuid binary";
	}
	const proven = escalation.startsWith("exec-refused:") || noNewPrivs === "1";
	if (!proven) {
		return `the allowPrivilegeEscalation invariant could not be demonstrated (escalation probe: ${escalation}, NoNewPrivs: ${noNewPrivs}) -- the sandbox neither refused to exec a setuid-root binary nor set PR_SET_NO_NEW_PRIVS, so a host that merely lacks sudo rights would look identical`;
	}
	return null;
}

/**
 * Runs the self-test in a throwaway sandbox and returns the status the backend
 * may report. Never throws: any error is itself a failed self-test, and a
 * self-test that blew up is not one that passed.
 */
export async function runSandboxSelfTest(options: SandboxSelfTestOptions): Promise<SandboxStatus> {
	const { backendName } = options;
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;

	let root: string | undefined;
	let server: Server | undefined;
	try {
		const created = mkdtempSync(join(tmpdir(), "draht-sandbox-selftest-"));
		// Real-path the throwaway root for the same reason R44-SBX.3 real-paths
		// policy paths: on macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
		// `/private/var/folders/...`, and the kernel matches the resolved vnode. An
		// unresolved root here makes the *positive* control fail -- which is how
		// this was found, and a good argument for having a positive control.
		const resolvedRoot = resolveRealPath(created, { base: created });
		if (!resolvedRoot.ok) {
			rmSync(created, { recursive: true, force: true });
			return unavailable(backendName, `could not resolve the throwaway probe directory: ${resolvedRoot.reason}`);
		}
		root = resolvedRoot.path;
		const inside = join(root, "inside");
		const outside = join(root, "outside");
		mkdirSync(inside);
		mkdirSync(outside);

		let accepted = 0;
		server = createServer((socket) => {
			accepted += 1;
			socket.destroy();
		});
		const listening = server;
		await new Promise<void>((resolve, reject) => {
			listening.once("error", reject);
			listening.listen(0, "127.0.0.1", resolve);
		});
		const address = listening.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		if (port === 0) return unavailable(backendName, "could not open a loopback listener for the network probe");

		const probeRoot = root;
		const probeScript = join(probeRoot, "probe.mjs");
		writeFileSync(probeScript, PROBE_SOURCE, { mode: 0o600 });

		/** One phase: writes a fresh config, runs the probe, returns what actually happened. */
		const runPhase = async (
			phase: "network-on" | "network-off",
		): Promise<{ report: ProbeReport; outsideFile: string; connectionsBefore: number } | SandboxStatus> => {
			const insideFile = join(inside, `${phase}.txt`);
			const outsideFile = join(outside, `${phase}.txt`);
			const configFile = join(probeRoot, `${phase}.json`);
			writeFileSync(
				configFile,
				JSON.stringify({
					insideFile,
					outsideFile,
					loopbackPort: port,
					connectTimeoutMs: PROBE_CONNECT_TIMEOUT_MS,
					marker: PROBE_MARKER,
				}),
				{ mode: 0o600 },
			);
			const connectionsBefore = accepted;
			const command = `${shellQuote(process.execPath)} ${shellQuote(probeScript)} ${shellQuote(configFile)}`;
			const { output } = await options.run(
				command,
				inside,
				probePolicy(inside, phase === "network-off" ? "off" : "on"),
				timeoutSeconds,
			);
			const report = parseReport(output);
			if (!report) {
				// No marker line means the probe never ran to completion. A broken
				// profile lands here (sandbox-exec exits before exec'ing anything) --
				// the single most important case not to mistake for confinement.
				return unavailable(
					backendName,
					`the ${phase} probe never reported a result, so the sandbox could not be shown to run commands at all (output: ${JSON.stringify(
						output.slice(-400),
					)})`,
				);
			}
			return { report, outsideFile, connectionsBefore };
		};

		// --- Phase 1: network on. Positive controls plus the write negative control.
		const first = await runPhase("network-on");
		if ("available" in first) return first;
		if (first.report.insideWrite !== "wrote") {
			return unavailable(
				backendName,
				`a write inside the allowlist was rejected (${first.report.insideWrite}) -- the profile does not grant the access the policy describes`,
			);
		}
		if (first.report.outsideWrite === "wrote" || existsSync(first.outsideFile)) {
			return unavailable(
				backendName,
				`a write outside the allowlist succeeded (${first.report.outsideWrite}), so the sandbox does not confine writes`,
			);
		}
		if (first.report.loopback !== "connected") {
			return unavailable(
				backendName,
				`the loopback probe could not connect with network allowed (${first.report.loopback}), so network confinement cannot be demonstrated either way`,
			);
		}
		if (accepted === first.connectionsBefore) {
			return unavailable(
				backendName,
				"the loopback listener saw no connection with network allowed, so the network probe proves nothing",
			);
		}
		const escalationFailure = privilegeEscalationFailure(first.report);
		if (escalationFailure) return unavailable(backendName, escalationFailure);

		// --- Phase 2: network off. The network negative control.
		const second = await runPhase("network-off");
		if ("available" in second) return second;
		if (second.report.outsideWrite === "wrote" || existsSync(second.outsideFile)) {
			return unavailable(backendName, "a write outside the allowlist succeeded with network off");
		}
		if (second.report.loopback === "connected") {
			return unavailable(backendName, "a loopback connection succeeded while the policy had network off");
		}
		if (accepted !== second.connectionsBefore) {
			return unavailable(
				backendName,
				"the loopback listener accepted a connection while the policy had network off, so the network denial does not hold",
			);
		}
		const escalationFailureOff = privilegeEscalationFailure(second.report);
		if (escalationFailureOff) return unavailable(backendName, `${escalationFailureOff} (with network off)`);

		return { available: true };
	} catch (err) {
		return unavailable(
			backendName,
			`the self-test itself failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		const openServer = server;
		if (openServer) await new Promise<void>((resolve) => openServer.close(() => resolve()));
		if (root) rmSync(root, { recursive: true, force: true });
	}
}
