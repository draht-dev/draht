import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@draht/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECKPOINT_REF_PREFIX, CheckpointManager } from "../src/core/checkpoints/checkpoint-manager.ts";
import {
	listRewindTargets,
	performRewind,
	REWIND_SCOPE_CHOICES,
	rewindScopeForLabel,
} from "../src/core/checkpoints/rewind.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "fixture@example.com"]);
	git(dir, ["config", "user.name", "Fixture User"]);
}

function write(dir: string, path: string, content: string): void {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

/** Every file in the working tree (excluding `.git`) with its content. */
function snapshotWorkingTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === ".git") continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			out[relative(dir, full)] = readFileSync(full, "utf8");
		}
	};
	walk(dir);
	return out;
}

function listCheckpointRefs(dir: string): string[] {
	const out = git(dir, ["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX]);
	return out ? out.split("\n") : [];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("performRewind scopes (R42-RWD.2, R42-RWD.5, R42-RWD.6)", () => {
	let root: string;
	let repo: string;
	let sessionFile: string;
	let manager: CheckpointManager;
	/** Stand-in for the conversation leaf; `navigate` is the only thing that moves it. */
	let leaf: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-rewind-command-test-"));
		repo = join(root, "repo");
		const sessionsDir = join(root, "sessions");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		sessionFile = join(sessionsDir, "2026-08-19T00-00-00-000Z_test-session.jsonl");
	});

	/**
	 * Fixture timeline (built inside each test body, not in a hook: git work
	 * needs the 30s test budget rather than the 10s hook budget):
	 *   commit  a.txt=v1, b.txt=keep
	 *   u1      checkpoint of that state
	 *   (agent) a.txt=v2, b.txt deleted, c.txt created
	 *   u2      checkpoint of the edited state, and the current leaf
	 *   (agent) a.txt=v3, d.txt created - after u2, so in no checkpoint at all;
	 *           only a pre-rewind safety snapshot can bring this state back
	 */
	async function buildFixture(): Promise<void> {
		initRepo(repo);
		write(repo, "a.txt", "v1\n");
		write(repo, "b.txt", "keep\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-m", "initial"]);

		manager = new CheckpointManager({ cwd: repo, sessionId: "session-1", sessionFile });
		expect((await manager.captureIfChanged("u1")).status).toBe("created");

		write(repo, "a.txt", "v2\n");
		rmSync(join(repo, "b.txt"));
		write(repo, "c.txt", "created\n");
		expect((await manager.captureIfChanged("u2")).status).toBe("created");

		write(repo, "a.txt", "v3\n");
		write(repo, "d.txt", "uncaptured\n");

		leaf = "u2";
	}

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const navigate = (to: string) => () => {
		leaf = to;
	};

	it("rewinds files and conversation together, and the abandoned state is recoverable by rewinding forward (R42-RWD.6)", async () => {
		await buildFixture();
		const abandoned = snapshotWorkingTree(repo);

		const back = await performRewind({
			manager,
			sessionId: "session-1",
			scope: "conversation-and-files",
			targetEntryId: "u1",
			currentEntryId: leaf,
			navigate: navigate("u1"),
		});

		expect(back.restore?.status).toBe("restored");
		expect(back.navigated).toBe(true);
		expect(leaf).toBe("u1");
		expect(snapshotWorkingTree(repo)).toEqual({ "a.txt": "v1\n", "b.txt": "keep\n" });
		expect(existsSync(join(repo, "c.txt"))).toBe(false);

		// Redo: the pre-rewind safety snapshot is keyed to the abandoned leaf,
		// so rewinding forward to it restores exactly the state we just left.
		const forward = await performRewind({
			manager,
			sessionId: "session-1",
			scope: "conversation-and-files",
			targetEntryId: "u2",
			currentEntryId: leaf,
			navigate: navigate("u2"),
		});

		expect(forward.restore?.status).toBe("restored");
		expect(forward.navigated).toBe(true);
		expect(leaf).toBe("u2");
		expect(snapshotWorkingTree(repo)).toEqual(abandoned);
		// d.txt exists in no checkpoint - it can only come from the safety snapshot.
		expect(readFileSync(join(repo, "d.txt"), "utf8")).toBe("uncaptured\n");
	}, 60_000);

	it("'conversation only' moves the leaf and leaves every file and ref untouched", async () => {
		await buildFixture();
		const before = snapshotWorkingTree(repo);
		const refsBefore = listCheckpointRefs(repo);

		const result = await performRewind({
			manager,
			sessionId: "session-1",
			scope: "conversation-only",
			targetEntryId: "u1",
			currentEntryId: leaf,
			navigate: navigate("u1"),
		});

		expect(result.navigated).toBe(true);
		expect(result.restore).toBeUndefined();
		expect(leaf).toBe("u1");
		expect(snapshotWorkingTree(repo)).toEqual(before);
		expect(listCheckpointRefs(repo)).toEqual(refsBefore);
	}, 60_000);

	it("'files only' restores the working tree and leaves the conversation leaf untouched", async () => {
		await buildFixture();
		let navigated = false;

		const result = await performRewind({
			manager,
			sessionId: "session-1",
			scope: "files-only",
			targetEntryId: "u1",
			currentEntryId: leaf,
			navigate: () => {
				navigated = true;
				leaf = "u1";
			},
		});

		expect(result.restore?.status).toBe("restored");
		expect(result.navigated).toBe(false);
		expect(navigated).toBe(false);
		expect(leaf).toBe("u2");
		expect(snapshotWorkingTree(repo)).toEqual({ "a.txt": "v1\n", "b.txt": "keep\n" });
	}, 60_000);

	it("does not move the conversation leaf when the file restore fails (R42-RWD.5)", async () => {
		await buildFixture();
		const before = snapshotWorkingTree(repo);

		const result = await performRewind({
			manager,
			sessionId: "session-1",
			scope: "conversation-and-files",
			targetEntryId: "u1",
			currentEntryId: leaf,
			navigate: navigate("u1"),
			onPathRestored: () => {
				throw new Error("injected mid-restore failure");
			},
		});

		expect(result.restore?.status).toBe("rolled-back");
		expect(result.navigated).toBe(false);
		expect(result.ok).toBe(false);
		expect(leaf).toBe("u2");
		expect(snapshotWorkingTree(repo)).toEqual(before);
	}, 60_000);

	it("lists checkpointed entries with their timestamp and dirty-file count (R42-RWD.1)", async () => {
		await buildFixture();
		const targets = listRewindTargets(manager.list());

		expect(targets.map((target) => target.entryId)).toEqual(["u1", "u2"]);
		for (const target of targets) {
			expect(Number.isNaN(Date.parse(target.timestamp))).toBe(false);
			expect(target.dirtyFileCount).toBeGreaterThanOrEqual(0);
		}
		// u2's snapshot differs from HEAD in a.txt, b.txt and c.txt.
		expect(targets[1].dirtyFileCount).toBe(3);
	}, 60_000);
});

describe("/rewind command surface (R42-RWD.1)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("registers the /rewind builtin command and the app.session.rewind action", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("rewind");
		expect(KEYBINDINGS["app.session.rewind"]).toBeDefined();
	});

	it("offers conversation+files as the default scope, then conversation only and files only (R42-RWD.2)", () => {
		expect(REWIND_SCOPE_CHOICES.map((choice) => choice.scope)).toEqual([
			"conversation-and-files",
			"conversation-only",
			"files-only",
		]);
		expect(rewindScopeForLabel(REWIND_SCOPE_CHOICES[1].label)).toBe("conversation-only");
		expect(rewindScopeForLabel("nonsense")).toBeUndefined();
	});

	it("reuses the tree selector, restricted to checkpointed entries and annotated", () => {
		const userMessage = (id: string, parentId: string | null, content: string): SessionMessageEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content, timestamp: Date.now() },
		});
		const entries = [
			userMessage("user-1", null, "first"),
			userMessage("user-2", "user-1", "uncheckpointed"),
			userMessage("user-3", "user-2", "second"),
		];
		const byId = new Map<string, SessionTreeNode>(entries.map((entry) => [entry.id, { entry, children: [] }]));
		for (const node of byId.values()) {
			if (node.entry.parentId) byId.get(node.entry.parentId)?.children.push(node);
		}
		const tree = [byId.get("user-1") as SessionTreeNode];

		const selector = new TreeSelectorComponent(
			tree,
			"user-3",
			24,
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			{
				title: "Rewind",
				checkpoints: new Map([
					["user-1", { timestamp: "2026-08-19T09:05:31.000Z", dirtyFileCount: 3 }],
					["user-3", { timestamp: "2026-08-19T09:06:00.000Z", dirtyFileCount: 1 }],
				]),
			},
		);

		const rendered = selector
			.getTreeList()
			.render(200)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");

		expect(rendered).toContain("first");
		expect(rendered).toContain("second");
		expect(rendered).not.toContain("uncheckpointed");
		expect(rendered).toContain("3 files");
		expect(rendered).toContain("1 file");
	});
});
