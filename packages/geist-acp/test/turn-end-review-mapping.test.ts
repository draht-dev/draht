/**
 * The turn-end mapping in `acp-harness-session.ts`: FOUR review states in,
 * three session statuses out — and `unknown` must come out as
 * `awaiting_review`.
 *
 * ## Why this is a separate file from `acp-harness-session.test.ts`
 *
 * That suite proves the `dirty → awaiting_review` arm, and `dirty` and
 * `unknown` share a destination, so it passes identically whether the
 * `unknown` arm exists or not: deleting `case "unknown"` lets it fall through
 * to the `default`, which answers `running` for a session whose `baseSha` was
 * captured successfully. Nothing there dies. This file exists to be the thing
 * that dies.
 *
 * ## The mechanism: a corrupt index, not a mock
 *
 * `worktreeReviewState()` is called by `dispatch()` on a real `cwd` with a real
 * `git`; there is no seam to inject through, and inventing one would be testing
 * the seam. So the worktree is made genuinely unreadable the way a real one
 * becomes unreadable — `.git/index` is overwritten with garbage — AFTER the
 * session has captured its `baseSha` (`git rev-parse HEAD` does not read the
 * index, so the capture is a real `{kind: "sha"}`, which is what puts the
 * `default` arm in play).
 *
 * `git status --porcelain` then exits 128 with `fatal: .git/index: index file
 * smaller than expected` — NOT "not a git repository", so it is not the
 * ordinary `no_repo` answer — and the review state is `unknown`. The test
 * asserts that input directly, so a failure here says which half broke.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SituationPrompt, worktreeReviewState } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

import { type AcpHarnessSession, createAcpHarnessSession } from "../src/acp-harness-session.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./fixtures/mock-agent.ts", import.meta.url));
const LAUNCH_SPEC: AgentLaunchSpec = { cmd: "bun", args: ["run", MOCK_AGENT_PATH] };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real git worktree with one commit, so `HEAD` resolves and the tree is clean. */
function makeGitWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "geist-acp-review-"));
	git(dir, ["init", "--quiet"]);
	git(dir, ["config", "user.email", "test@geist.local"]);
	git(dir, ["config", "user.name", "Geist Test"]);
	writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "--quiet", "-m", "initial"]);
	return dir;
}

/** Makes every index-reading git command in `cwd` fail with exit 128. */
function corruptGitIndex(cwd: string): void {
	writeFileSync(join(cwd, ".git", "index"), "not an index", "utf8");
}

let cwd: string;
let session: AcpHarnessSession | undefined;

beforeEach(() => {
	cwd = makeGitWorktree();
	session = undefined;
});

afterEach(async () => {
	// Never leave a subprocess or temp worktree behind, even on assertion failure.
	if (session) await session.stop();
	rmSync(cwd, { recursive: true, force: true });
});

test("a turn ending against a worktree nobody can read is `awaiting_review`, not `running`", async () => {
	session = await createAcpHarnessSession(LAUNCH_SPEC, cwd);
	expect(session.status).toBe("running");

	// Answer the permission the mock raises mid-turn, or the turn never ends.
	const boundSession = session;
	session.onPermissionRequest((event) => {
		const allow = event.options.find((option) => option.kind === "allow_once") ?? event.options[0];
		void boundSession.answerPermission(event.requestId, allow.optionId);
	});

	// The session captured a real baseSha at spawn (the repo was intact then),
	// so the `default` arm — the one a deleted `case "unknown"` falls into —
	// would answer `running` here.
	corruptGitIndex(cwd);

	// The input to the mapping, asserted rather than assumed: git refuses, and
	// it refuses in a way that is NOT the ordinary `no_repo` answer.
	const headSha = git(cwd, ["rev-parse", "HEAD"]).trim();
	expect(headSha.length).toBeGreaterThan(0);
	expect(worktreeReviewState(cwd, headSha)).toBe("unknown");

	const prompt: SituationPrompt = { blocks: [{ type: "text", text: "make the primary button blue" }] };
	await session.dispatch(prompt);

	// Not knowing resolves TOWARDS review, never away from it: `running` is the
	// one answer a human acts on by moving to the next thing, and a worktree
	// nobody can read is exactly when a human should look instead.
	expect(session.status).toBe("awaiting_review");
	expect(session.status).not.toBe("running");
}, 60_000);
