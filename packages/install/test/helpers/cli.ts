import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunCliOptions, runCli } from "../../src/run-cli.ts";

export interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}

export type CliOverrides = Partial<Omit<RunCliOptions, "argv" | "io">> & {
	isTTY?: boolean;
	confirm?: () => Promise<boolean>;
};

/**
 * Drives `runCli` in-process with captured streams. Every ambient input the CLI
 * can read (env, cwd, TTY-ness, bin name) is passed explicitly so a test can
 * never accidentally depend on the real environment.
 */
export async function runCliCapture(argv: string[], overrides: CliOverrides = {}): Promise<CliRun> {
	let stdout = "";
	let stderr = "";
	const { isTTY = false, confirm, ...rest } = overrides;

	const code = await runCli({
		argv,
		binName: "draht-install",
		env: { PATH: "" },
		cwd: process.cwd(),
		...rest,
		io: {
			stdout: (chunk) => {
				stdout += chunk;
			},
			stderr: (chunk) => {
				stderr += chunk;
			},
			isTTY,
			confirm,
		},
	});

	return { code, stdout, stderr };
}

/** Creates a temp directory removed when `dispose()` is called. */
export function tempRoot(prefix: string): { path: string; dispose: () => void } {
	const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
	return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}
