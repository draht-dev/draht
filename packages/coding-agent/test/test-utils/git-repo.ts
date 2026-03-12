import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_GIT_USER_EMAIL = "gsd-test@example.com";
const DEFAULT_GIT_USER_NAME = "GSD Test";
const DEFAULT_INITIAL_TRACKED_FILE_PATH = "README.md";
const DEFAULT_INITIAL_TRACKED_FILE_CONTENT = "# GSD Test Repo\n";

export interface TempGitRepoFile {
	path: string;
	content: string;
}

export interface CreateTempGitRepoOptions {
	initialTrackedFile?: TempGitRepoFile;
}

export interface TempGitRepo {
	repoPath: string;
	cleanup: () => void;
}

export function createTempGitRepo(options: CreateTempGitRepoOptions = {}): TempGitRepo {
	const repoPath = mkdtempSync(join(tmpdir(), "gsd-temp-git-repo-"));
	const initialTrackedFile = options.initialTrackedFile ?? {
		path: DEFAULT_INITIAL_TRACKED_FILE_PATH,
		content: DEFAULT_INITIAL_TRACKED_FILE_CONTENT,
	};

	git(repoPath, "init");
	git(repoPath, `config user.email ${JSON.stringify(DEFAULT_GIT_USER_EMAIL)}`);
	git(repoPath, `config user.name ${JSON.stringify(DEFAULT_GIT_USER_NAME)}`);
	writeTrackedFile(repoPath, initialTrackedFile);
	git(repoPath, "add .");
	git(repoPath, `commit -m ${JSON.stringify("chore: initial commit")}`);

	return {
		repoPath,
		cleanup: () => cleanupTempDir(repoPath),
	};
}

function git(repoPath: string, args: string): void {
	execSync(`git ${args}`, { cwd: repoPath, stdio: "pipe" });
}

function writeTrackedFile(repoPath: string, trackedFile: TempGitRepoFile): void {
	const trackedFilePath = join(repoPath, trackedFile.path);
	mkdirSync(dirname(trackedFilePath), { recursive: true });
	writeFileSync(trackedFilePath, trackedFile.content, "utf-8");
}

function cleanupTempDir(repoPath: string): void {
	if (existsSync(repoPath)) {
		rmSync(repoPath, { recursive: true, force: true });
	}
}
