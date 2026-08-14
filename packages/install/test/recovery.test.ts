import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, type MaterializedComponent } from "../src/executor.ts";
import { hashTree } from "../src/hash.ts";
import { appendJournal, openTransactions, readJournal } from "../src/journal.ts";
import { backupsDir, stagingDir } from "../src/paths.ts";
import { assessCrashedTransactions, recoverCrashedTransactions } from "../src/recovery.ts";
import { createDefaultState, loadState, saveState } from "../src/state.ts";
import type { PlanAction } from "../src/types.ts";
import { tempRoot } from "./helpers/cli.ts";

const CHILD = join(import.meta.dirname, "helpers", "crash-child.ts");

interface Harness {
	dispose: () => void;
	home: string;
	root: string;
	target: string;
}

function harness(): Harness {
	const tmp = tempRoot("recovery");
	const home = join(tmp.path, "home");
	const root = join(home, ".draht", "install");
	const target = join(home, ".draht", "claude-marketplace");
	mkdirSync(root, { recursive: true });
	return { dispose: tmp.dispose, home, root, target };
}

/** Runs the crash child as a real subprocess and asserts it died by SIGKILL rather than exiting. */
function crashChild(root: string, target: string, killAfter: string): void {
	const result = spawnSync("npx", ["tsx", CHILD, root, target, killAfter], {
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env },
	});
	// Killed by SIGKILL. `npx` reports it as 128+9 rather than propagating the
	// signal, so accept either shape — both mean the process was torn down
	// uncatchably rather than exiting through any code path of its own.
	const killed = result.signal === "SIGKILL" || result.status === 137;
	expect(
		killed,
		`child did not die by SIGKILL: ${JSON.stringify({ status: result.status, signal: result.signal, stderr: result.stderr?.slice(-400) })}`,
	).toBe(true);
}

describe("crash assessment", () => {
	it("finds nothing to recover on a clean root", () => {
		const h = harness();
		try {
			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(true);
			expect(assessment.entries).toEqual([]);
			expect(assessment.blockers).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	it("refuses to assess a torn journal instead of guessing the missing tail", () => {
		const h = harness();
		try {
			appendJournal(h.root, { tx: "tx-1", seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			writeFileSync(
				join(h.root, "journal.jsonl"),
				`${readFileSync(join(h.root, "journal.jsonl"), "utf8")}{"tx":"tx-1"`,
			);

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/torn|incomplete/i);
		} finally {
			h.dispose();
		}
	});

	it("refuses a leftover backup directory whose transaction the journal never recorded", () => {
		const h = harness();
		try {
			mkdirSync(join(backupsDir(h.root, "tx-orphan"), "alpha"), { recursive: true });

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toContain("tx-orphan");
		} finally {
			h.dispose();
		}
	});

	it("refuses a journalled target that fails target safety validation", () => {
		const h = harness();
		try {
			appendJournal(h.root, { tx: "tx-evil", seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			appendJournal(h.root, {
				tx: "tx-evil",
				seq: 2,
				at: "2026-01-01T00:00:00.000Z",
				event: "staged",
				detail: { componentId: "alpha", type: "install", targetDir: "/etc/cron.d" },
			});
			appendJournal(h.root, {
				tx: "tx-evil",
				seq: 3,
				at: "2026-01-01T00:00:00.000Z",
				event: "swapped",
				detail: { componentId: "alpha" },
			});

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/\/etc\/cron\.d/);
		} finally {
			h.dispose();
		}
	});

	it("refuses a symlink backup rather than restoring it as the live payload", () => {
		const h = harness();
		try {
			const tx = "tx-link";
			const unrelated = join(h.home, "unrelated", "payload");
			mkdirSync(unrelated, { recursive: true });
			writeFileSync(join(unrelated, "secret.txt"), "UNRELATED");
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			appendJournal(h.root, {
				tx,
				seq: 2,
				at: "2026-01-01T00:00:01.000Z",
				event: "staged",
				detail: { componentId: "alpha", type: "update", targetDir: h.target },
			});
			appendJournal(h.root, {
				tx,
				seq: 3,
				at: "2026-01-01T00:00:02.000Z",
				event: "swapped",
				detail: { componentId: "alpha" },
			});
			mkdirSync(backupsDir(h.root, tx), { recursive: true });
			symlinkSync(unrelated, join(backupsDir(h.root, tx), "alpha"), "dir");

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/backup.*symbolic link|symlink/i);
			expect(() => recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root })).toThrow(
				/symlink|symbolic link/i,
			);
			expect(lstatSync(join(backupsDir(h.root, tx), "alpha")).isSymbolicLink()).toBe(true);
			expect(existsSync(h.target)).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("refuses automatic recovery when a crash may have changed an external host", () => {
		const h = harness();
		try {
			appendJournal(h.root, { tx: "tx-host", seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			appendJournal(h.root, {
				tx: "tx-host",
				seq: 2,
				at: "2026-01-01T00:00:00.000Z",
				event: "external-intent",
				detail: {
					componentId: "claude-plugin",
					description: "claude host registration may have changed; reconcile it",
				},
			});

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/claude-plugin.*reconcile/i);
			expect(() => recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root })).toThrow(
				/claude-plugin.*reconcile/i,
			);
		} finally {
			h.dispose();
		}
	});

	it("finalizes a transaction that state.json committed before the terminal journal event", () => {
		const h = harness();
		try {
			const state = createDefaultState();
			state.lastTx = "tx-committed";
			saveState(h.root, state);
			appendJournal(h.root, { tx: "tx-committed", seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			appendJournal(h.root, {
				tx: "tx-committed",
				seq: 2,
				at: "2026-01-01T00:00:00.000Z",
				event: "swapped",
				detail: { componentId: "alpha" },
			});
			mkdirSync(join(stagingDir(h.root, "tx-committed"), "alpha"), { recursive: true });
			mkdirSync(join(backupsDir(h.root, "tx-committed"), "alpha"), { recursive: true });
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "COMMITTED");

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.transactions).toContain("tx-committed");
			expect(result.notes.join(" ")).toMatch(/finalized.*committed/i);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("COMMITTED");
			expect(existsSync(stagingDir(h.root, "tx-committed"))).toBe(false);
			expect(existsSync(backupsDir(h.root, "tx-committed"))).toBe(false);
			expect(openTransactions(readJournal(h.root).entries)).not.toContain("tx-committed");
			expect(recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root }).transactions).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	it("finalizes a state-confirmed commit when its terminal journal append tore", () => {
		const h = harness();
		try {
			const tx = "tx-committed-torn";
			const state = createDefaultState();
			state.lastTx = tx;
			saveState(h.root, state);
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			appendJournal(h.root, {
				tx,
				seq: 2,
				at: "2026-01-01T00:00:01.000Z",
				event: "swapped",
				detail: { componentId: "alpha" },
			});
			mkdirSync(join(stagingDir(h.root, tx), "alpha"), { recursive: true });
			mkdirSync(join(backupsDir(h.root, tx), "alpha"), { recursive: true });
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "COMMITTED");
			const journal = join(h.root, "journal.jsonl");
			writeFileSync(
				journal,
				`${readFileSync(journal, "utf8")}{"tx":"${tx}","seq":3,"at":"2026-01-01T00:00:02.000Z","event":"committed"`,
			);

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.transactions).toEqual([tx]);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("COMMITTED");
			expect(existsSync(stagingDir(h.root, tx))).toBe(false);
			expect(existsSync(backupsDir(h.root, tx))).toBe(false);
			expect(readJournal(h.root).torn).toBe(false);
			expect(openTransactions(readJournal(h.root).entries)).not.toContain(tx);
		} finally {
			h.dispose();
		}
	});

	it("refuses a torn tail for another transaction despite a state-confirmed commit", () => {
		const h = harness();
		try {
			const tx = "tx-committed-before-foreign-tail";
			const state = createDefaultState();
			state.lastTx = tx;
			saveState(h.root, state);
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			const journal = join(h.root, "journal.jsonl");
			writeFileSync(journal, `${readFileSync(journal, "utf8")}{"tx":"tx-other","seq":1`);

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/torn|incomplete/i);
			expect(() => recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root })).toThrow(
				/torn|incomplete/i,
			);
		} finally {
			h.dispose();
		}
	});

	it("refuses an ambiguous comment event prefix for a state-confirmed transaction", () => {
		const h = harness();
		try {
			const tx = "tx-committed-ambiguous";
			const state = createDefaultState();
			state.lastTx = tx;
			saveState(h.root, state);
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			const journal = join(h.root, "journal.jsonl");
			writeFileSync(journal, `${readFileSync(journal, "utf8")}{"tx":"${tx}","event":"comment`);

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(assessment.blockers.join(" ")).toMatch(/torn|incomplete/i);
		} finally {
			h.dispose();
		}
	});

	it.each([
		[
			"duplicate event",
			(tx: string) =>
				`{"tx":"${tx}","event":"comment","seq":3,"at":"2026-01-01T00:00:02.000Z","event":"committed","detail":`,
		],
		[
			"duplicate transaction",
			(tx: string) =>
				`{"tx":"${tx}","tx":"tx-foreign","seq":3,"at":"2026-01-01T00:00:02.000Z","event":"committed","detail":`,
		],
		[
			"inserted field",
			(tx: string) =>
				`{"tx":"${tx}","extra":true,"seq":3,"at":"2026-01-01T00:00:02.000Z","event":"committed","detail":`,
		],
	])("refuses a noncanonical torn tail with %s", (_label, makeTail) => {
		const h = harness();
		try {
			const tx = "tx-committed-noncanonical";
			const state = createDefaultState();
			state.lastTx = tx;
			saveState(h.root, state);
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			const journal = join(h.root, "journal.jsonl");
			const tail = makeTail(tx);
			writeFileSync(journal, `${readFileSync(journal, "utf8")}${tail}`);

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(readFileSync(journal, "utf8")).toContain(tail);
		} finally {
			h.dispose();
		}
	});

	it.each([
		["zero sequence", "0", "2026-01-01T00:00:02.000Z"],
		["unsafe sequence", "9007199254740992", "2026-01-01T00:00:02.000Z"],
		["400-digit sequence", "1".repeat(400), "2026-01-01T00:00:02.000Z"],
		["invalid month", "3", "2026-99-01T00:00:02.000Z"],
		["invalid calendar day", "3", "2026-02-31T00:00:02.000Z"],
		["invalid hour", "3", "2026-01-01T29:00:02.000Z"],
	])("refuses a canonical-looking torn tail with %s", (_label, seq, at) => {
		const h = harness();
		try {
			const tx = "tx-committed-invalid-scalars";
			const state = createDefaultState();
			state.lastTx = tx;
			saveState(h.root, state);
			appendJournal(h.root, { tx, seq: 1, at: "2026-01-01T00:00:00.000Z", event: "planned" });
			mkdirSync(join(stagingDir(h.root, tx), "alpha"), { recursive: true });
			mkdirSync(join(backupsDir(h.root, tx), "alpha"), { recursive: true });
			const journal = join(h.root, "journal.jsonl");
			const tail = `{"tx":"${tx}","seq":${seq},"at":"${at}","event":"committed"`;
			writeFileSync(journal, `${readFileSync(journal, "utf8")}${tail}`);

			const assessment = assessCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(assessment.recoverable).toBe(false);
			expect(readFileSync(journal, "utf8")).toContain(tail);
			expect(existsSync(stagingDir(h.root, tx))).toBe(true);
			expect(existsSync(backupsDir(h.root, tx))).toBe(true);
		} finally {
			h.dispose();
		}
	});
});

describe("crash recovery after a real SIGKILL", () => {
	it("restores the previous payload byte-for-byte when the process is killed after the swap", () => {
		const h = harness();
		try {
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "ORIGINAL");

			crashChild(h.root, h.target, "after-swap");

			// The crash left the new payload in place and the original in backups.
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("NEW");
			expect(openTransactions(readJournal(h.root).entries)).toHaveLength(1);

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.recovered).toBe(true);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("ORIGINAL");
			expect(loadState(h.root).components).toEqual({});
			expect(openTransactions(readJournal(h.root).entries)).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	it("removes a half-installed fresh payload when the process is killed after the swap", () => {
		const h = harness();
		try {
			// No previous payload at all: recovery must delete, not restore.
			crashChild(h.root, h.target, "after-swap");

			expect(existsSync(join(h.target, "payload.txt"))).toBe(true);

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.recovered).toBe(true);
			expect(existsSync(h.target)).toBe(false);
			expect(loadState(h.root).components).toEqual({});
		} finally {
			h.dispose();
		}
	});

	it("removes a fresh payload when killed after the live move but before the swapped journal event", () => {
		const h = harness();
		try {
			crashChild(h.root, h.target, "after-swap-before-journal");
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("NEW");

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.recovered).toBe(true);
			expect(existsSync(h.target)).toBe(false);
			expect(loadState(h.root).components).toEqual({});
		} finally {
			h.dispose();
		}
	});

	it("cleans up staging when the process is killed before anything was swapped", () => {
		const h = harness();
		try {
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "ORIGINAL");

			crashChild(h.root, h.target, "after-stage");

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.recovered).toBe(true);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("ORIGINAL");
			expect(existsSync(stagingDir(h.root, result.transactions[0]))).toBe(false);
			expect(existsSync(backupsDir(h.root, result.transactions[0]))).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("restores the original when the process is killed between backup and swap", () => {
		const h = harness();
		try {
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "ORIGINAL");

			crashChild(h.root, h.target, "after-backup");

			// Mid-transaction the target does not exist: it has been moved aside.
			expect(existsSync(h.target)).toBe(false);

			const result = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(result.recovered).toBe(true);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("ORIGINAL");
		} finally {
			h.dispose();
		}
	});

	it("is idempotent: a second recovery finds nothing left to do", () => {
		const h = harness();
		try {
			mkdirSync(h.target, { recursive: true });
			writeFileSync(join(h.target, "payload.txt"), "ORIGINAL");
			crashChild(h.root, h.target, "after-swap");

			recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });
			const second = recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root });

			expect(second.transactions).toEqual([]);
			expect(readFileSync(join(h.target, "payload.txt"), "utf8")).toBe("ORIGINAL");
		} finally {
			h.dispose();
		}
	});

	it("refuses to recover and reports why when the journal is unusable", () => {
		const h = harness();
		try {
			mkdirSync(join(backupsDir(h.root, "tx-orphan"), "alpha"), { recursive: true });

			expect(() => recoverCrashedTransactions(h.root, { home: h.home, installRoot: h.root })).toThrow(/tx-orphan/);
		} finally {
			h.dispose();
		}
	});
});

describe("delegated actions inside a transaction", () => {
	function delegatedPlan(): PlanAction[] {
		return [{ type: "delegate-install", componentId: "coding-agent", kind: "global-cli" }];
	}

	it("records a delegated install in state without inventing a file manifest", async () => {
		const h = harness();
		try {
			const result = await applyPlan({
				root: h.root,
				plan: delegatedPlan(),
				materialize: async () => {
					throw new Error("materialize must not be called for a delegated action");
				},
				delegate: async () => ({
					version: "1.2.3",
					source: { npmName: "@draht/coding-agent", resolvedVersion: "1.2.3" },
					delegated: { method: "npm-global", packageName: "@draht/coding-agent" },
					effectiveness: "next-session" as const,
				}),
			});

			const component = result.state.components["coding-agent"];
			expect(component.version).toBe("1.2.3");
			expect(component.files).toEqual([]);
			expect(component.delegated).toEqual({ method: "npm-global", packageName: "@draht/coding-agent" });
			expect(component.effectiveness).toBe("next-session");
		} finally {
			h.dispose();
		}
	});

	it("reports an external delegated effect it cannot roll back rather than claiming it did", async () => {
		const h = harness();
		try {
			const plan: PlanAction[] = [
				{ type: "delegate-install", componentId: "coding-agent", kind: "global-cli" },
				{
					type: "install",
					componentId: "claude-plugin",
					kind: "claude-plugin",
					toVersion: "1.0.0",
					source: { npmName: "draht-claude", resolvedVersion: "1.0.0" },
				},
			];

			const error = await applyPlan({
				root: h.root,
				plan,
				materialize: async (_action, staging): Promise<MaterializedComponent> => {
					mkdirSync(staging, { recursive: true });
					writeFileSync(join(staging, "f.txt"), "x");
					return {
						targetDir: h.target,
						files: await hashTree(staging),
						version: "1.0.0",
						source: { npmName: "draht-claude", resolvedVersion: "1.0.0" },
					};
				},
				delegate: async () => ({
					version: "1.2.3",
					source: { npmName: "@draht/coding-agent", resolvedVersion: "1.2.3" },
					delegated: { method: "npm-global", packageName: "@draht/coding-agent" },
					effectiveness: "next-session" as const,
				}),
				register: async () => {
					throw new Error("host refused");
				},
			}).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).not.toBeNull();
			const applyError = error as { unrolledEffects: string[]; message: string };
			expect(applyError.unrolledEffects.join(" ")).toContain("@draht/coding-agent");
			expect(applyError.unrolledEffects.join(" ")).toMatch(/not rolled back|cannot be rolled back/i);
			// state.json is untouched by a failed transaction.
			expect(loadState(h.root).components).toEqual({});
		} finally {
			h.dispose();
		}
	});
});
