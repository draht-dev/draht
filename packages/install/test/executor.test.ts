import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ApplyError,
	applyPlan,
	type CheckpointName,
	detectCrashedTransactions,
	type MaterializedComponent,
} from "../src/executor.ts";
import { hashTree } from "../src/hash.ts";
import { appendJournal, readJournal } from "../src/journal.ts";
import { backupsDir, stagingDir } from "../src/paths.ts";
import { computePlan, type DesiredComponent } from "../src/plan.ts";
import { loadState } from "../src/state.ts";
import type { ComponentSource, InstallState, PlanAction } from "../src/types.ts";

let root: string;
let targetsRoot: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "draht-install-"));
	targetsRoot = mkdtempSync(join(tmpdir(), "draht-install-targets-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(targetsRoot, { recursive: true, force: true });
});

function sourceFor(id: string, version: string): ComponentSource {
	return { npmName: `@draht/${id}`, resolvedVersion: version };
}

function targetDirFor(id: string): string {
	return join(targetsRoot, id);
}

/** Builds a `materialize` callback that writes fixed file contents into the staging directory per component. */
function makeMaterialize(content: Record<string, Record<string, string>>) {
	return async (action: PlanAction, stagingComponentDir: string): Promise<MaterializedComponent> => {
		const files = content[action.componentId] ?? {};
		for (const [relPath, body] of Object.entries(files)) {
			const filePath = join(stagingComponentDir, relPath);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, body);
		}
		const hashed = await hashTree(stagingComponentDir);
		const toVersion = action.type === "install" || action.type === "update" ? action.toVersion : "0.0.0";
		return {
			targetDir: targetDirFor(action.componentId),
			files: hashed,
			version: toVersion,
			source: sourceFor(action.componentId, toVersion),
		};
	};
}

describe("applyPlan happy path", () => {
	it("installs two components: targets exist, state saved, journal committed, staging/backups cleaned", async () => {
		const plan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
			{
				type: "install",
				componentId: "beta",
				kind: "codex-plugin",
				toVersion: "1.0.0",
				source: sourceFor("beta", "1.0.0"),
			},
		];
		const materialize = makeMaterialize({
			alpha: { "index.js": "alpha-content" },
			beta: { "index.js": "beta-content", "nested/file.txt": "nested-content" },
		});

		const registeredIds: string[] = [];
		const checkpointCalls: Array<{ name: CheckpointName; componentId?: string }> = [];

		const result = await applyPlan({
			root,
			plan,
			materialize,
			register: async (action) => {
				registeredIds.push(action.componentId);
			},
			checkpoint: (name, action) => {
				checkpointCalls.push({ name, componentId: action?.componentId });
			},
		});

		expect(readFileSync(join(targetDirFor("alpha"), "index.js"), "utf8")).toBe("alpha-content");
		expect(readFileSync(join(targetDirFor("beta"), "index.js"), "utf8")).toBe("beta-content");
		expect(readFileSync(join(targetDirFor("beta"), "nested", "file.txt"), "utf8")).toBe("nested-content");

		const state: InstallState = loadState(root);
		expect(state.components.alpha?.version).toBe("1.0.0");
		expect(state.components.beta?.version).toBe("1.0.0");
		expect(state.lastTx).toBe(result.tx);

		expect(registeredIds.sort()).toEqual(["alpha", "beta"]);
		expect(checkpointCalls.filter((c) => c.componentId === "alpha").map((c) => c.name)).toEqual([
			"after-stage",
			"after-backup",
			"after-swap",
			"after-register",
		]);
		expect(checkpointCalls.filter((c) => c.componentId === "beta").map((c) => c.name)).toEqual([
			"after-stage",
			"after-backup",
			"after-swap",
			"after-register",
		]);

		const { entries, torn } = readJournal(root);
		expect(torn).toBe(false);
		const txEntries = entries.filter((e) => e.tx === result.tx);
		expect(txEntries.map((e) => e.event)).toEqual([
			"planned",
			"staged",
			"backed-up",
			"swap-intent",
			"swapped",
			"external-intent",
			"registered",
			"staged",
			"backed-up",
			"swap-intent",
			"swapped",
			"external-intent",
			"registered",
			"committed",
		]);

		expect(existsSync(stagingDir(root, result.tx))).toBe(false);
		expect(existsSync(backupsDir(root, result.tx))).toBe(false);
	});
});

describe("applyPlan fault injection", () => {
	const CHECKPOINT_NAMES: CheckpointName[] = ["after-stage", "after-backup", "after-swap", "after-register"];

	it.each(CHECKPOINT_NAMES)("rolls back the entire transaction when checkpoint %s throws", async (checkpointName) => {
		// Seed "alpha" as an already-installed component so the fault-injection
		// attempt below genuinely exercises backup + restore, not just a fresh install.
		const seedPlan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
		];
		await applyPlan({ root, plan: seedPlan, materialize: makeMaterialize({ alpha: { "index.js": "alpha-old" } }) });

		const preApplyState = loadState(root);
		const preApplyTree = await hashTree(targetsRoot);

		const plan: PlanAction[] = [
			{
				type: "update",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "2.0.0",
				fromVersion: "1.0.0",
				source: sourceFor("alpha", "2.0.0"),
			},
			{
				type: "install",
				componentId: "beta",
				kind: "codex-plugin",
				toVersion: "1.0.0",
				source: sourceFor("beta", "1.0.0"),
			},
		];
		const materialize = makeMaterialize({
			alpha: { "index.js": "alpha-new" },
			beta: { "index.js": "beta-content" },
		});

		let hits = 0;
		let injectedError: Error | undefined;
		const checkpoint = (name: CheckpointName): void => {
			if (name !== checkpointName) return;
			hits += 1;
			// Let the first action (alpha) fully complete; fail on the second
			// action's (beta) occurrence of this checkpoint, so rollback must
			// also undo an already-completed action, not just the failing one.
			if (hits === 2) {
				injectedError = new Error(`fault-injected at ${checkpointName}`);
				throw injectedError;
			}
		};

		let caught: unknown;
		try {
			await applyPlan({ root, plan, materialize, checkpoint });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ApplyError);
		const applyError = caught as ApplyError;
		expect(applyError.failedAction?.componentId).toBe("beta");
		expect(applyError.cause).toBe(injectedError);
		expect(applyError.message).toContain(`fault-injected at ${checkpointName}`);

		const postFailureTree = await hashTree(targetsRoot);
		expect(postFailureTree).toEqual(preApplyTree);
		expect(loadState(root)).toEqual(preApplyState);

		const { entries } = readJournal(root);
		expect(entries.at(-1)?.event).toBe("rolled-back");

		expect(existsSync(stagingDir(root, applyError.tx))).toBe(false);
		expect(existsSync(backupsDir(root, applyError.tx))).toBe(false);
	});

	it("reports a possibly mutated host when registration throws after the filesystem swap", async () => {
		const seedPlan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
		];
		await applyPlan({ root, plan: seedPlan, materialize: makeMaterialize({ alpha: { "index.js": "old" } }) });
		const beforeState = loadState(root);
		const beforeTree = await hashTree(targetsRoot);

		let caught: unknown;
		try {
			await applyPlan({
				root,
				plan: [
					{
						type: "update",
						componentId: "alpha",
						kind: "claude-plugin",
						fromVersion: "1.0.0",
						toVersion: "2.0.0",
						source: sourceFor("alpha", "2.0.0"),
					},
				],
				materialize: makeMaterialize({ alpha: { "index.js": "new" } }),
				register: async () => {
					throw new Error("host removed the old registration, then rejected the replacement");
				},
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ApplyError);
		const applyError = caught as ApplyError;
		expect(applyError.unrolledEffects).toEqual([
			expect.stringMatching(/host registration for alpha may have changed.*reconcile/i),
		]);
		expect(await hashTree(targetsRoot)).toEqual(beforeTree);
		expect(loadState(root)).toEqual(beforeState);
		const rolledBack = readJournal(root).entries.at(-1);
		expect(rolledBack?.event).toBe("rolled-back");
		expect(rolledBack?.detail).toMatchObject({ unrolledEffects: applyError.unrolledEffects });
	});

	it("records external effects before materialization or delegation can mutate and throw", async () => {
		const install: PlanAction = {
			type: "install",
			componentId: "alpha",
			kind: "claude-plugin",
			toVersion: "1.0.0",
			source: sourceFor("alpha", "1.0.0"),
		};
		await expect(
			applyPlan({
				root,
				plan: [install],
				materialize: async (_action, _staging, transaction) => {
					transaction.noteExternalEffect("host deregistration for alpha may have changed; reconcile it");
					throw new Error("host mutated then failed");
				},
			}),
		).rejects.toMatchObject({
			unrolledEffects: [expect.stringMatching(/host deregistration for alpha.*reconcile/i)],
		});

		const delegated: PlanAction = {
			type: "delegate-install",
			componentId: "installer",
			kind: "global-cli",
		};
		await expect(
			applyPlan({
				root,
				plan: [delegated],
				materialize: makeMaterialize({}),
				delegate: async () => {
					throw new Error("npm mutated then failed");
				},
			}),
		).rejects.toMatchObject({
			unrolledEffects: [expect.stringMatching(/package-manager delegate-install for installer.*reconcile/i)],
		});
	});
});

describe("applyPlan idempotence", () => {
	it("computePlan finds zero actions after a successful apply, using disk hashes from hashTree", async () => {
		const plan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
			{
				type: "install",
				componentId: "beta",
				kind: "codex-plugin",
				toVersion: "1.0.0",
				source: sourceFor("beta", "1.0.0"),
			},
		];
		const materialize = makeMaterialize({
			alpha: { "index.js": "alpha-content" },
			beta: { "index.js": "beta-content" },
		});

		await applyPlan({ root, plan, materialize });

		const state = loadState(root);
		const diskByComponent = new Map<string, Array<{ path: string; sha256: string }>>();
		for (const componentId of Object.keys(state.components)) {
			diskByComponent.set(componentId, await hashTree(targetDirFor(componentId)));
		}

		const desired: DesiredComponent[] = [
			{ id: "alpha", kind: "claude-plugin", version: "1.0.0", source: sourceFor("alpha", "1.0.0") },
			{ id: "beta", kind: "codex-plugin", version: "1.0.0", source: sourceFor("beta", "1.0.0") },
		];

		const recomputed = computePlan({
			desired,
			state,
			diskFiles: (componentId) => diskByComponent.get(componentId) ?? null,
		});

		expect(recomputed).toEqual({ actions: [], blocked: [] });
	});
});

describe("detectCrashedTransactions", () => {
	it("surfaces a transaction with no terminal journal event and a leftover staging directory", () => {
		const tx = "tx-crashed-1";
		appendJournal(root, { tx, seq: 1, at: "2026-08-12T00:00:00.000Z", event: "planned" });
		appendJournal(root, { tx, seq: 2, at: "2026-08-12T00:00:01.000Z", event: "staged" });

		const leftoverStagingDir = join(stagingDir(root, tx), "some-component");
		mkdirSync(leftoverStagingDir, { recursive: true });
		writeFileSync(join(leftoverStagingDir, "index.js"), "leftover");

		const findings = detectCrashedTransactions(root);

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "error", repairable: false });
		expect(findings[0].id).toContain(tx);
	});

	it("reports no findings after a clean commit (no leftover working directories)", async () => {
		const plan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
		];
		await applyPlan({ root, plan, materialize: makeMaterialize({ alpha: { "index.js": "alpha-content" } }) });

		expect(detectCrashedTransactions(root)).toEqual([]);
	});

	it("reports no findings after a clean rollback (no leftover working directories)", async () => {
		const plan: PlanAction[] = [
			{
				type: "install",
				componentId: "alpha",
				kind: "claude-plugin",
				toVersion: "1.0.0",
				source: sourceFor("alpha", "1.0.0"),
			},
		];
		const materialize = makeMaterialize({ alpha: { "index.js": "alpha-content" } });

		await expect(
			applyPlan({
				root,
				plan,
				materialize,
				checkpoint: (name) => {
					if (name === "after-stage") throw new Error("boom");
				},
			}),
		).rejects.toThrow(ApplyError);

		expect(detectCrashedTransactions(root)).toEqual([]);
	});
});
