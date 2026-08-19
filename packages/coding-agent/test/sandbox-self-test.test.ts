/**
 * R44-SBX.4 -- what the startup self-test must refuse to call `available`.
 *
 * The macOS integration tests in `sandbox-backend.test.ts` prove the *real*
 * seatbelt backend passes. This file proves the *gate* is a gate, by driving
 * `runSandboxSelfTest` through its injected runner and handing it probe reports
 * a compromised backend would produce. Every case here is a backend that must be
 * rejected, plus the positive controls that stop "reject everything" from being
 * a passing implementation.
 *
 * The case this file exists for is the privilege-escalation one. `SandboxPolicy`
 * types `allowPrivilegeEscalation` as the literal `false` because it is an
 * invariant, and the self-test used to grant `available` without testing it at
 * all -- while `linux.ts` names this self-test as its entire safety argument.
 */

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { runSandboxSelfTest, type SandboxSelfTestRunner } from "../src/core/sandbox/index.ts";

interface ProbeConfig {
	insideFile: string;
	outsideFile: string;
	loopbackPort: number;
	marker: string;
}

interface FakeBackend {
	/** Write the file the probe was told to create inside the allowlist. Default true. */
	honoursInsideWrite?: boolean;
	/** Let the write outside the allowlist through. Default false (a confining backend). */
	leaksOutsideWrite?: boolean;
	/** Connect to the loopback listener even when the policy says network off. Default false. */
	leaksNetworkWhenOff?: boolean;
	/** What the escalation attempt reported. `null` omits the field entirely (an older probe). */
	privilegeEscalation?: string | null;
	noNewPrivs?: string | null;
}

/** The last single-quoted word of the probe invocation is its config file. */
function configPathFrom(command: string): string {
	const match = /'([^']*)'\s*$/.exec(command);
	if (!match?.[1]) throw new Error(`could not find the probe config path in ${JSON.stringify(command)}`);
	return match[1];
}

/** Connects, then waits for the peer to hang up, so the listener's accept has certainly been counted. */
async function connectAndWaitForClose(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("error", () => resolve(false));
		socket.once("close", () => resolve(true));
		socket.once("connect", () => {
			// The server destroys the socket; "close" below is the acknowledgement.
		});
	});
}

/**
 * A runner that behaves like a sandbox with exactly the defects `backend`
 * describes. It performs the real filesystem and network effects the probe would
 * have, so the self-test's out-of-band confirmations (does the outside file
 * exist? did the listener accept?) see the truth rather than a claim.
 */
function fakeRunner(backend: FakeBackend = {}): SandboxSelfTestRunner {
	return async (command, _cwd, policy) => {
		const config = JSON.parse(readFileSync(configPathFrom(command), "utf8")) as ProbeConfig;
		const { writeFileSync } = await import("node:fs");

		const insideWrite = backend.honoursInsideWrite === false ? "blocked:EPERM" : "wrote";
		if (insideWrite === "wrote") writeFileSync(config.insideFile, "probe");

		let outsideWrite = "blocked:EPERM";
		if (backend.leaksOutsideWrite) {
			writeFileSync(config.outsideFile, "probe");
			outsideWrite = "wrote";
		}

		const shouldConnect = policy.network === "on" || backend.leaksNetworkWhenOff === true;
		const loopback = shouldConnect
			? (await connectAndWaitForClose(config.loopbackPort))
				? "connected"
				: "blocked:ECONNREFUSED"
			: "blocked:EPERM";

		const report: Record<string, string> = { insideWrite, outsideWrite, loopback };
		const escalation = backend.privilegeEscalation === undefined ? "exec-refused:EPERM" : backend.privilegeEscalation;
		const noNewPrivs = backend.noNewPrivs === undefined ? "not-linux" : backend.noNewPrivs;
		if (escalation !== null) report.privilegeEscalation = escalation;
		if (noNewPrivs !== null) report.noNewPrivs = noNewPrivs;

		return { exitCode: 0, output: `\n${config.marker}${JSON.stringify(report)}\n` };
	};
}

async function statusFor(backend: FakeBackend = {}) {
	return await runSandboxSelfTest({ backendName: "fake", run: fakeRunner(backend), timeoutSeconds: 10 });
}

function reasonOf(status: Awaited<ReturnType<typeof statusFor>>): string {
	return status.available ? "" : status.reason;
}

describe("self-test: the privilege-escalation invariant (R44-SBX.4)", () => {
	it("refuses `available` when a setuid-root binary acquires privileges inside the sandbox", async () => {
		const status = await statusFor({ privilegeEscalation: "escalated:euid=0" });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("acquired privileges");
		expect(reasonOf(status)).toContain("allowPrivilegeEscalation");
	});

	it("refuses `available` when the kernel reports NoNewPrivs: 0", async () => {
		const status = await statusFor({ privilegeEscalation: "ran:/usr/bin/sudo:exit=1", noNewPrivs: "0" });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("NoNewPrivs: 0");
	});

	it("refuses `available` when the invariant is merely untested, not shown to hold", async () => {
		// A host where the user simply has no sudo rights produces this exact report
		// while entirely unconfined -- the one-sided-probe mistake, applied to setuid.
		const status = await statusFor({ privilegeEscalation: "ran:/usr/bin/sudo:exit=1", noNewPrivs: "not-linux" });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("could not be demonstrated");
	});

	it("refuses `available` when no setuid-root binary was there to attempt it with", async () => {
		const status = await statusFor({ privilegeEscalation: "no-setuid-root-binary", noNewPrivs: "not-linux" });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("could not be demonstrated");
	});

	it("refuses `available` when the probe never reported the attempt at all", async () => {
		const status = await statusFor({ privilegeEscalation: null, noNewPrivs: null });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("did not report a privilege-escalation attempt");
	});

	it("accepts the darwin evidence: the kernel refused to exec a setuid-root binary", async () => {
		expect(await statusFor({ privilegeEscalation: "exec-refused:EPERM", noNewPrivs: "not-linux" })).toEqual({
			available: true,
		});
	});

	it("accepts the linux/bubblewrap evidence: NoNewPrivs is 1, so setuid is inert", async () => {
		expect(await statusFor({ privilegeEscalation: "ran:/usr/bin/sudo:exit=1", noNewPrivs: "1" })).toEqual({
			available: true,
		});
	});
});

describe("self-test: the controls that were already there stay wired", () => {
	it("passes a backend that confines writes and the network and blocks escalation", async () => {
		expect(await statusFor()).toEqual({ available: true });
	});

	it("refuses a backend that lets a write outside the allowlist through", async () => {
		const status = await statusFor({ leaksOutsideWrite: true });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("outside the allowlist");
	});

	it("refuses a backend that rejects a write the policy explicitly allows", async () => {
		const status = await statusFor({ honoursInsideWrite: false });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("inside the allowlist");
	});

	it("refuses a backend that lets a loopback connection out with network off", async () => {
		const status = await statusFor({ leaksNetworkWhenOff: true });

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toMatch(/loopback|network/i);
	});

	it("refuses a runner that never ran the probe at all", async () => {
		const status = await runSandboxSelfTest({
			backendName: "fake",
			run: async () => ({ exitCode: 65, output: "sandbox-exec: profile syntax error" }),
		});

		expect(status.available).toBe(false);
		expect(reasonOf(status)).toContain("never reported a result");
	});
});
