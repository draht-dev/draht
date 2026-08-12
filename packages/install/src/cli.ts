#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "./run-cli.ts";

/**
 * The process entry point, kept deliberately thin: it wires `process` into
 * `runCli` and translates signals into an abort. Every behavior worth testing
 * lives in `runCli` and is reachable without spawning a process.
 */

const controller = new AbortController();
let stopping = false;

/**
 * First signal asks the engine to stop at its next safe point — between
 * actions — so an in-flight transaction rolls back cleanly rather than being
 * torn in half. A second signal means the operator is done waiting; the
 * process leaves immediately and the journal plus backups let the next run
 * recover.
 */
function onSignal(signal: NodeJS.Signals): void {
	if (stopping) {
		process.stderr.write(`\ndraht-install: ${signal} again — exiting now; run "draht-install doctor" afterwards\n`);
		process.exit(130);
	}
	stopping = true;
	controller.abort();
	process.stderr.write(`\ndraht-install: ${signal} received — finishing the current step, then rolling back\n`);
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(`${question} [y/N] `);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

const exitCode = await runCli({
	argv: process.argv.slice(2),
	binName: process.argv[1] ?? "draht-install",
	env: process.env,
	cwd: process.cwd(),
	signal: controller.signal,
	io: {
		stdout: (chunk) => process.stdout.write(chunk),
		stderr: (chunk) => process.stderr.write(chunk),
		isTTY: Boolean(process.stdin.isTTY),
		confirm,
	},
});

process.exitCode = exitCode;
