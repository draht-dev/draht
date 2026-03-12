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

	execSync("git init", { cwd: repoPath, stdio: "pipe" });
	execSync(`git config user.email ${JSON.stringify(DEFAULT_GIT_USER_EMAIL)}`, {
		cwd: repoPath,
		stdio: "pipe",
	});
	execSync(`git config user.name ${JSON.stringify(DEFAULT_GIT_USER_NAME)}`, {
		cwd: repoPath,
		stdio: "pipe",
	});

	const trackedFilePath = join(repoPath, initialTrackedFile.path);
	mkdirSync(dirname(trackedFilePath), { recursive: true });
	writeFileSync(trackedFilePath, initialTrackedFile.content, "utf-8");

	execSync("git add .", { cwd: repoPath, stdio: "pipe" });
	execSync(`git commit -m ${JSON.stringify("chore: initial commit")}`, {
		cwd: repoPath,
		stdio: "pipe",
	});

	return {
		repoPath,
		cleanup: () => {
			if (existsSync(repoPath)) {
				rmSync(repoPath, { recursive: true, force: true });
			}
		},
	};
}
