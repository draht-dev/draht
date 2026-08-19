/**
 * R32-FLEET.11 — the keyless stub provider must serve a SPAWNED draht binary.
 *
 * `registerFauxProvider` from "@draht/ai/compat" only ever reaches the provider
 * registry of the process that calls it, so it cannot give a child process any
 * assistant output. Every acceptance from Phase 32 on spawns a real `draht` and
 * needs real streamed assistant text with no API key and no network, so the stub
 * has to be selectable from OUTSIDE the process — by environment variable.
 *
 * These tests therefore drive the emitted binary (dist/cli.js, the file both
 * `bin.draht` and the bun-compiled binary are built from), never an in-process
 * import: an in-process test would pass while the product a child process sees
 * stayed broken.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

/** A port nothing listens on: any outbound HTTP the child attempts must fail. */
const DEAD_PROXY = "http://127.0.0.1:1";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/**
 * The child's entire environment, built from nothing rather than filtered from
 * `process.env`: a filter can miss a provider key spelling, a from-scratch env
 * cannot. No credential of any kind is passed, and both proxy variables point at
 * a closed port so a provider that needed the network would fail loudly.
 */
function childEnv(home: string, agentDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: home,
		DRAHT_CODING_AGENT_DIR: agentDir,
		HTTP_PROXY: DEAD_PROXY,
		HTTPS_PROXY: DEAD_PROXY,
		ALL_PROXY: DEAD_PROXY,
		...extra,
	};
}

/**
 * Build exactly what `npm run build` builds — compile plus the asset copy — so
 * the binary under test is the emitted one, not a half-built tree that happens
 * to have a cli.js in it.
 */
async function buildEmittedBinary(): Promise<void> {
	const result = await run("npm", ["run", "build"], { cwd: PKG_ROOT, env: process.env });
	if (result.code !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`);
}

beforeAll(async () => {
	await buildEmittedBinary();
}, 180_000);

afterAll(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("keyless stub provider in a spawned draht binary (R32-FLEET.11)", () => {
	test("the spawned binary answers a prompt with deterministic text, keyless and offline", async () => {
		const home = await createTempDir("draht-stub-home-");
		const agentDir = await createTempDir("draht-stub-agent-");
		const env = childEnv(home, agentDir, { DRAHT_STUB_PROVIDER: "1" });

		// The guarantee this test rests on: nothing credential-shaped is handed down.
		expect(Object.keys(env).filter((name) => /KEY|TOKEN|SECRET|CREDENTIAL/i.test(name))).toEqual([]);

		const result = await run(
			process.execPath,
			[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--no-session", "ping from the fleet"],
			{ cwd: home, env },
		);

		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("stub: ping from the fleet");
	}, 120_000);

	test("the assistant text arrives as a stream of deltas, not one final blob", async () => {
		const home = await createTempDir("draht-stub-home-");
		const agentDir = await createTempDir("draht-stub-agent-");
		const env = childEnv(home, agentDir, { DRAHT_STUB_PROVIDER: "1" });

		const result = await run(
			process.execPath,
			[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--no-session", "--mode", "json", "stream me"],
			{ cwd: home, env },
		);

		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

		const events = result.stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const deltas = events
			.filter((event) => event.type === "message_update")
			.map((event) => event.assistantMessageEvent as { type: string; delta?: string })
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta ?? "");

		// Fixed four-character deltas: the stream is reproducible frame for frame,
		// which is what lets a later phase assert on partial output mid-stream.
		expect(deltas).toEqual(["stub", ": st", "ream", " me"]);
		expect(deltas.join("")).toBe("stub: stream me");
	}, 120_000);

	test("without the environment variable the stub provider does not exist", async () => {
		const home = await createTempDir("draht-stub-home-");
		const agentDir = await createTempDir("draht-stub-agent-");
		const result = await run(
			process.execPath,
			[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--no-session", "ping"],
			{ cwd: home, env: childEnv(home, agentDir) },
		);

		expect(result.code).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain('Unknown provider "draht-stub"');
	}, 120_000);
});
