import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepo } from "./git-repo.js";

describe("createTempGitRepo", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			const cleanup = cleanups.pop();
			cleanup?.();
		}
	});

	it("creates an isolated temp git repo with an initial commit", () => {
		const repo = createTempGitRepo();
		cleanups.push(repo.cleanup);

		expect(fs.existsSync(repo.repoPath)).toBe(true);
		expect(fs.existsSync(`${repo.repoPath}/.git`)).toBe(true);
		expect(readGitOutput(repo.repoPath, "rev-parse HEAD")).toMatch(/^[0-9a-f]{40}$/);
	});

	it("configures deterministic git identity for the temp repo", () => {
		const repo = createTempGitRepo();
		cleanups.push(repo.cleanup);

		expect(readGitOutput(repo.repoPath, "config user.email")).toBe("gsd-test@example.com");
		expect(readGitOutput(repo.repoPath, "config user.name")).toBe("GSD Test");
	});

	it("cleanup removes the temp directory", () => {
		const repo = createTempGitRepo();
		const { repoPath } = repo;

		expect(fs.existsSync(repoPath)).toBe(true);

		repo.cleanup();

		expect(fs.existsSync(repoPath)).toBe(false);
	});

	it("honors optional helper config without changing repo validity", () => {
		const repo = createTempGitRepo({
			initialTrackedFile: {
				path: "fixtures/domain/Order.ts",
				content: "export interface Order {\n\tid: string;\n}\n",
			},
		});
		cleanups.push(repo.cleanup);

		expect(fs.existsSync(`${repo.repoPath}/fixtures/domain/Order.ts`)).toBe(true);
		expect(readGitOutput(repo.repoPath, "rev-parse HEAD")).toMatch(/^[0-9a-f]{40}$/);
	});
});

function readGitOutput(repoPath: string, args: string): string {
	return execSync(`git ${args}`, {
		cwd: repoPath,
		encoding: "utf-8",
	}).trim();
}
