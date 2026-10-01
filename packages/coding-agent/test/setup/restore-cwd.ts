import { existsSync } from "node:fs";
import { afterAll, afterEach } from "vitest";

// Vitest reuses a worker process across test files. A file that chdirs into a
// temp directory and then deletes it leaves every later file in that worker
// with a cwd that no longer exists, and any git it spawns dies with
// "Unable to read current working directory". Restore the worker's original
// cwd whenever the current one has vanished, and always at the end of a file.
const workerCwd = process.cwd();

function cwdIsGone(): boolean {
	try {
		return !existsSync(process.cwd());
	} catch {
		return true;
	}
}

afterEach(() => {
	if (cwdIsGone()) process.chdir(workerCwd);
});

afterAll(() => {
	if (cwdIsGone() || process.cwd() !== workerCwd) process.chdir(workerCwd);
});
