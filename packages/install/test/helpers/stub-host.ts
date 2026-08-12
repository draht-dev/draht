import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostRunOptions, HostRunResult } from "../../src/host.ts";

export interface RecordedCall {
	file: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface StubResponse {
	status?: number;
	stdout?: string;
	stderr?: string;
}

export interface StubHost {
	runner: HostRunner;
	calls: RecordedCall[];
	/** `file arg arg …` command lines, in order — the shape adapter sequence assertions read. */
	commandLines: () => string[];
}

export interface StubRule {
	match: RegExp | string;
	/**
	 * A single answer, or a sequence consumed one per matching call with the
	 * last entry sticking. A sequence is how a test models a host whose answer
	 * legitimately changes — "not installed" before an install, "installed"
	 * when the adapter verifies afterwards.
	 */
	respond: StubResponse | StubResponse[];
}

/**
 * A recording `HostRunner`. Responses are matched against the joined command
 * line so a test states exactly what each host call answers, and every call is
 * captured with its cwd and env for argv/cwd/env assertions.
 */
export function createStubHost(responses: StubRule[] = []): StubHost {
	const calls: RecordedCall[] = [];
	const consumed = new Map<StubRule, number>();

	const runner: HostRunner = (file: string, args: string[], options: HostRunOptions = {}): HostRunResult => {
		calls.push({ file, args, cwd: options.cwd, env: options.env });
		const line = [file, ...args].join(" ");
		for (const rule of responses) {
			const matched = typeof rule.match === "string" ? line.includes(rule.match) : rule.match.test(line);
			if (!matched) continue;
			let respond: StubResponse;
			if (Array.isArray(rule.respond)) {
				const index = consumed.get(rule) ?? 0;
				respond = rule.respond[Math.min(index, rule.respond.length - 1)];
				consumed.set(rule, index + 1);
			} else {
				respond = rule.respond;
			}
			return { status: respond.status ?? 0, stdout: respond.stdout ?? "", stderr: respond.stderr ?? "" };
		}
		return { status: 0, stdout: "", stderr: "" };
	};

	return {
		runner,
		calls,
		commandLines: () => calls.map((call) => [call.file, ...call.args].join(" ")),
	};
}

/**
 * Writes a real executable stub that appends its argv, cwd and selected env to
 * `logPath` and replies with `stdout` for matching subcommands. Used by the
 * e2e, where the CLI runs as a real subprocess and no in-process seam exists.
 */
export function writeStubBinary(
	binDir: string,
	name: string,
	options: { logPath: string; responses?: Array<{ match: string; stdout: string }>; exitCode?: number } = {
		logPath: "",
	},
): string {
	mkdirSync(binDir, { recursive: true });
	const path = join(binDir, name);
	const cases = (options.responses ?? [])
		.map(({ match, stdout }) => `  *"${match}"*)\n    printf '%s' ${JSON.stringify(stdout)}\n    exit 0\n    ;;`)
		.join("\n");

	writeFileSync(
		path,
		`#!/bin/sh
# Stub ${name} for hermetic installer tests. Records the exact argv, cwd and
# DRAHT_* env it was invoked with, then answers from a fixed response table.
printf '%s\\n' "ARGV\\t${name}\\t$*" >> ${JSON.stringify(options.logPath)}
printf '%s\\n' "CWD\\t$(pwd)" >> ${JSON.stringify(options.logPath)}
printf '%s\\n' "HOME\\t\${HOME}" >> ${JSON.stringify(options.logPath)}
case "$*" in
${cases}
esac
exit ${options.exitCode ?? 0}
`,
	);
	chmodSync(path, 0o755);
	return path;
}
