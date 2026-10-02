import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inject } from "vitest";

const PKG_ROOT = resolve(__dirname, "..");
const LOCK_TIMEOUT_MS = 280_000;
const LOCK_POLL_MS = 200;

function runBuild(): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("bun", ["run", "build"], {
			cwd: PKG_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`build failed:\n${out}`))));
	});
}

async function acquireLock(lockDir: string): Promise<void> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			// mkdir is atomic: exactly one worker creates it, every other one gets EEXIST.
			mkdirSync(lockDir);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${LOCK_TIMEOUT_MS}ms waiting for another worker's build of dist/`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
	}
}

/**
 * Build packages/coding-agent/dist (`bun run build`) at most once per vitest run.
 *
 * Several e2e files drive the emitted binary and each needs a fresh dist/. Rebuilding it from
 * every file raced across vitest workers: `tsc` truncates and rewrites dist/*.js and the bundle
 * step deletes dist/bundle, so one worker's build broke another worker's running CLI ("does not
 * provide an export named ...", ENOENT on dist/bundle). The first caller builds under a lock;
 * later callers in the same run wait for it and reuse the result. A failed build leaves no
 * marker, so the next caller retries and reports its own failure.
 */
export async function ensureEmittedBuild(): Promise<void> {
	const runDir = inject("emittedBuildRunDir");
	const lockDir = join(runDir, "lock");
	const marker = join(runDir, "built");
	await acquireLock(lockDir);
	try {
		if (existsSync(marker)) return;
		await runBuild();
		writeFileSync(marker, "");
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}
