// Scriptable fake child process for child-process.test.ts. Plain Node ESM, no imports beyond
// node:*, so it runs unmodified under `process.execPath` regardless of how the test runner itself
// was launched.
//
// Env:
//   FAKE_CHILD_SCENARIO    path to a JSONL file replayed to stdout
//   FAKE_CHILD_ECHO        path to append one JSON line describing this invocation (argv/env/
//                          stdin/systemPrompt/systemPromptMode/schemaMode). `<FAKE_CHILD_ECHO>.ready`
//                          is written as soon as this process's SIGTERM handling is installed, so a
//                          test can poll for it before sending SIGTERM instead of racing process startup.
//   FAKE_CHILD_ECHO_KEYS   comma-separated extra env var names to include in the echo
//   FAKE_CHILD_CHUNK       stdout write chunk size in bytes (default 65536)
//   FAKE_CHILD_MODE        normal | exit-early | hang | ignore-sigterm | model-error | stderr-flood

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.resume();
	});
}

function nextTick() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Byte offset of the start of the line containing `"agent_settled"`, or the buffer length if absent. */
function exitEarlyStopOffset(buffer) {
	const matchIndex = buffer.indexOf('"agent_settled"');
	if (matchIndex === -1) return buffer.length;
	const lineStart = buffer.lastIndexOf(0x0a, matchIndex);
	return lineStart === -1 ? 0 : lineStart + 1;
}

async function writeInChunks(buffer, chunkSize, stopAt) {
	let offset = 0;
	const limit = Math.min(stopAt, buffer.length);
	while (offset < limit) {
		const end = Math.min(offset + chunkSize, limit);
		process.stdout.write(buffer.subarray(offset, end));
		offset = end;
		await nextTick();
	}
}

async function main() {
	const env = process.env;
	const mode = env.FAKE_CHILD_MODE || "normal";
	const chunkSize = Number.parseInt(env.FAKE_CHILD_CHUNK ?? "", 10) || 65536;
	const echoKeys = (env.FAKE_CHILD_ECHO_KEYS ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);

	// Installed before anything async (including reading stdin) so a test that waits for
	// `<FAKE_CHILD_ECHO>.ready` can be certain SIGTERM is already handled, regardless of how
	// long process startup itself took. `hangUntilSigterm` is created synchronously, in the same
	// tick as the handler, so there is no gap where a SIGTERM could arrive with no resolve to call.
	let hangUntilSigterm;
	if (mode === "hang") {
		const keepAlive = setInterval(() => {}, 1000);
		hangUntilSigterm = new Promise((resolve) => {
			process.once("SIGTERM", () => {
				clearInterval(keepAlive);
				process.exitCode = 143;
				resolve();
			});
		});
	}
	if (mode === "ignore-sigterm") {
		process.on("SIGTERM", () => {});
	}
	if (env.FAKE_CHILD_ECHO) {
		writeFileSync(`${env.FAKE_CHILD_ECHO}.ready`, "");
	}

	const stdin = await readStdin();

	const promptFlagIndex = process.argv.indexOf("--append-system-prompt");
	const systemPromptFile = promptFlagIndex === -1 ? undefined : process.argv[promptFlagIndex + 1];
	const systemPrompt = systemPromptFile ? readFileSync(systemPromptFile, "utf8") : undefined;
	// Read back while the parent still owns the temp dir (it is removed once this process exits),
	// so a test can assert the mode the parent wrote the file with (e.g. 0o600).
	const systemPromptMode = systemPromptFile ? statSync(systemPromptFile).mode & 0o777 : undefined;
	const schemaFile = env.DRAHT_POLYPHASE_SCHEMA_FILE;
	const schemaMode = schemaFile ? statSync(schemaFile).mode & 0o777 : undefined;

	if (env.FAKE_CHILD_ECHO) {
		const echoedEnv = {
			DRAHT_POLYPHASE_DEPTH: env.DRAHT_POLYPHASE_DEPTH,
			DRAHT_POLYPHASE_SCHEMA_FILE: env.DRAHT_POLYPHASE_SCHEMA_FILE,
		};
		for (const key of echoKeys) echoedEnv[key] = env[key];
		appendFileSync(
			env.FAKE_CHILD_ECHO,
			`${JSON.stringify({
				argv: process.argv.slice(2),
				env: echoedEnv,
				stdin,
				systemPrompt,
				systemPromptMode,
				schemaMode,
			})}\n`,
		);
	}

	if (mode === "model-error" && process.argv.includes("--model")) {
		process.stderr.write("Unknown model\n");
		process.exitCode = 1;
		return;
	}

	if (mode === "stderr-flood") {
		process.stderr.write("x".repeat(1024 * 1024));
	}

	if (mode === "hang") {
		await hangUntilSigterm;
		return;
	}

	if (env.FAKE_CHILD_SCENARIO) {
		const buffer = readFileSync(env.FAKE_CHILD_SCENARIO);
		const stopAt = mode === "exit-early" ? exitEarlyStopOffset(buffer) : buffer.length;
		await writeInChunks(buffer, chunkSize, stopAt);
	}

	if (mode === "exit-early") {
		process.exitCode = 2;
		return;
	}

	if (mode === "ignore-sigterm") {
		// Already ignoring SIGTERM: stay alive (via an open interval) until the parent
		// escalates to SIGKILL. A bare pending promise would not keep the event loop open.
		setInterval(() => {}, 1000);
		await new Promise(() => {});
		return;
	}

	process.exitCode = 0;
}

main();
