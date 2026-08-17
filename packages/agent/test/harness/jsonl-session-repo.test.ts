import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_STORAGE_VERSION, JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

describe("JsonlSessionRepo cwd-scoped lifecycle", () => {
	it("persists metadata and filters discovery by cwd", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create({ id: "child", cwd: "/workspace", parentSessionId: "parent" });
		const metadata = session.metadata;

		expect(metadata).toMatchObject({
			id: "child",
			createdAt: NOW,
			storageVersion: JSONL_STORAGE_VERSION,
			cwd: "/workspace",
			parentSessionId: "parent",
		});
		expect(metadata.path).toContain("/sessions/--workspace--/");
		expect(metadata.path.endsWith("_child.jsonl")).toBe(true);
		expect(Number.isFinite(metadata.modifiedAt)).toBe(true);
		await session.close();

		expect(await repo.list({ cwd: "/other" })).toEqual([]);
		expect(await repo.list({ cwd: "/workspace" })).toEqual([metadata]);
		const firstLine = getOrThrow(await fileSystem.readTextLines(metadata.path, { maxLines: 1 }))[0];
		expect(JSON.parse(firstLine!)).toEqual({
			v: 4,
			kind: "header",
			id: "child",
			storageVersion: JSONL_STORAGE_VERSION,
			createdAt: NOW,
			cwd: "/workspace",
			parentSessionId: "parent",
		});
		await repo.close();
	});

	it("keeps fork destinations claimed until close and rejects deleting open sessions", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const source = await repo.create({ id: "source", cwd: "/workspace" });
		const fork = await repo.fork(source.metadata, { id: "fork" });

		await expect(repo.open(fork.metadata)).rejects.toThrow("already open");
		await expect(repo.delete(fork.metadata)).rejects.toThrow("open");
		await fork.close();

		const reopened = await repo.open(fork.metadata);
		await reopened.close();
		await repo.delete(fork.metadata);
		await expect(repo.open(fork.metadata)).rejects.toThrow("does not exist");

		await source.close();
		await repo.close();
	});

	it("rejects concurrent creates for the same working-directory id", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });

		const results = await Promise.allSettled([
			repo.create({ id: "session", cwd: "/workspace" }),
			repo.create({ id: "session", cwd: "/workspace" }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await repo.list({ cwd: "/workspace" })).toHaveLength(1);
		for (const result of results) {
			if (result.status === "fulfilled") await result.value.close();
		}
		await repo.close();
	});

	it("allows the same id to be active in different working directories", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const first = await repo.create({ id: "shared", cwd: "/workspace-a" });
		const second = await repo.create({ id: "shared", cwd: "/workspace-b" });

		expect(first.metadata.path).not.toBe(second.metadata.path);
		await expect(repo.create({ id: "shared", cwd: "/workspace-a" })).rejects.toThrow("already exists");
		expect((await repo.list()).map(({ cwd, id }) => ({ cwd, id }))).toEqual([
			{ cwd: "/workspace-a", id: "shared" },
			{ cwd: "/workspace-b", id: "shared" },
		]);

		await Promise.all([first.close(), second.close()]);
		const reopened = await Promise.all([repo.open(first.metadata), repo.open(second.metadata)]);
		await Promise.all(reopened.map((session) => session.close()));
		await repo.close();
	});
});
