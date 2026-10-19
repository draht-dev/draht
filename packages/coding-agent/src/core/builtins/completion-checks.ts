import { join } from "node:path";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import type { BoundaryResult, ExtensionAPI } from "../extensions/types.ts";

const MAX_REPAIR_ATTEMPTS = 3;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUNNER_TIMEOUT_MS = 160_000;

interface CheckResult {
	status: "passed" | "failed" | "skipped";
	configured: boolean;
	summary: string;
	diagnostics?: string;
}

function failed(summary: string): CheckResult {
	return { status: "failed", configured: true, summary };
}

function parseResult(output: string): CheckResult {
	const value: unknown = JSON.parse(output);
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		!("configured" in value) ||
		!("summary" in value) ||
		(value.status !== "passed" && value.status !== "failed" && value.status !== "skipped") ||
		typeof value.configured !== "boolean" ||
		typeof value.summary !== "string"
	) {
		throw new Error("Invalid project-check result");
	}
	const diagnostics =
		"checks" in value && Array.isArray(value.checks)
			? value.checks
					.flatMap((check: unknown) => {
						if (typeof check !== "object" || check === null || !("status" in check) || check.status !== "failed")
							return [];
						return "output" in check && typeof check.output === "string" ? [check.output] : [];
					})
					.join("\n")
					.slice(0, 12_000)
			: "";
	return { status: value.status, configured: value.configured, summary: value.summary, diagnostics };
}

function startCheckRunner(cwd: string) {
	const runtime = join(getPackageDir(), "hooks", "checks", "checks-runtime.cjs");
	return spawnProcess(isBunBinary ? "node" : process.execPath, [runtime, "--cwd", cwd, "--json"], {
		cwd,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Run the same packaged checks as the plugin hosts without blocking the session event loop. */
async function runChecks(cwd: string, signal: AbortSignal): Promise<CheckResult> {
	let child: ReturnType<typeof startCheckRunner>;
	try {
		child = startCheckRunner(cwd);
	} catch (error) {
		return failed(`Project-check runner could not start: ${error instanceof Error ? error.message : String(error)}`);
	}
	let output = "";
	let errors = "";
	let termination: string | undefined;
	const terminate = (reason: string) => {
		termination ??= reason;
		try {
			if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			// A process that has already exited needs no further cancellation.
		}
	};
	const onAbort = () => terminate("Project checks were cancelled");
	const timeout = setTimeout(
		() => terminate("Project checks exceeded the 160-second runner limit"),
		RUNNER_TIMEOUT_MS,
	);
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) terminate("Project-check output exceeded 1 MiB");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		errors = `${errors}${chunk.toString()}`.slice(-4000);
	});
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const code = await waitForChildProcess(child);
		if (termination) return failed(termination);
		const result = parseResult(output);
		if (code !== 0 && result.status !== "failed") {
			return failed(`Project-check runner exited ${code ?? "without an exit status"}. ${errors}`.trim());
		}
		return result;
	} catch (error) {
		return failed(
			`Project-check runner failed: ${error instanceof Error ? error.message : String(error)}. ${errors}`.trim(),
		);
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}
}

export default function completionChecksBuiltin(pi: ExtensionAPI) {
	let repairAttempts = 0;
	let currentCheck: AbortController | undefined;
	pi.on("before_agent_start", () => {
		repairAttempts = 0;
	});
	pi.on("session_shutdown", () => currentCheck?.abort());
	pi.on("agent_before_settle", async (event, ctx): Promise<BoundaryResult | undefined> => {
		if (event.outcome !== "completed" || !ctx.isProjectTrusted()) return;
		currentCheck = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, currentCheck.signal]) : currentCheck.signal;
		let result: CheckResult;
		try {
			result = await runChecks(ctx.cwd, signal);
		} finally {
			currentCheck = undefined;
		}
		if (result.status === "skipped") return;
		let content = [result.summary, result.diagnostics].filter(Boolean).join("\n");
		let continueRun = false;
		if (result.status === "failed") {
			if (repairAttempts < MAX_REPAIR_ATTEMPTS && !signal.aborted) {
				repairAttempts++;
				continueRun = true;
				content = `Project verification failed (repair ${repairAttempts}/${MAX_REPAIR_ATTEMPTS}). Fix the reported failures within the requested scope, then report the result.\n${content}`;
			} else {
				content = `Project verification failed. Automatic repair stopped; this work is not verified.\n${content}`;
				ctx.ui.notify(content, "error");
				ctx.abort();
			}
		}
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "project-checks", content, display: true, details: result },
			],
			continue: event.continue || continueRun,
		};
	});
}
