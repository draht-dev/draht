import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SocketServer } from "../src/core/socket-server/socket-server.ts";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("socket file permissions", () => {
	test("the socket sits in a 0700 directory and is not group- or other-accessible", async () => {
		const dir = await createTempDir("dsock-perm-");
		const socketDir = path.join(dir, "sockets");

		// A permissive process umask must not leak into anything the server creates.
		const previousUmask = process.umask(0o022);
		try {
			const server = new SocketServer({ sessionId: "perm", socketDir, cwd: dir });
			await server.start();
			try {
				// The directory is what actually makes the socket unreachable at connect(2)
				// for other users, so it carries the guarantee.
				const dirMode = (await stat(socketDir)).mode & 0o777;
				expect(dirMode.toString(8)).toBe("700");

				const socketMode = (await stat(path.join(socketDir, "perm.sock"))).mode & 0o777;
				expect(socketMode & 0o077).toBe(0);
				expect(socketMode.toString(8)).toBe("600");

				const lockMode = (await stat(path.join(socketDir, "perm.lock"))).mode & 0o777;
				expect(lockMode & 0o077).toBe(0);
			} finally {
				await server.stop();
			}
		} finally {
			process.umask(previousUmask);
		}
	});

	test("starting the server never mutates the process-global umask", async () => {
		const dir = await createTempDir("dsock-umask-");
		const socketDir = path.join(dir, "sockets");

		const umaskSpy = vi.spyOn(process, "umask");
		try {
			const server = new SocketServer({ sessionId: "umask", socketDir, cwd: dir });
			await server.start();
			await server.stop();

			// Reading the umask is fine; setting it is a side effect on every other file
			// this process creates concurrently.
			const mutations = umaskSpy.mock.calls.filter((call) => call.length > 0);
			expect(mutations).toEqual([]);
		} finally {
			umaskSpy.mockRestore();
		}
	});
});
