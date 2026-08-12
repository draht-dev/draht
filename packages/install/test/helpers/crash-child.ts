/**
 * Child process for the SIGKILL crash test. Applies a one-component plan and
 * hard-kills itself immediately after the swap is journaled — a real
 * uncatchable process death, not an in-process exception, so the recovery it
 * proves is genuine rather than simulated.
 *
 * argv: <installRoot> <targetDir> <killAfter>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { CheckpointName } from "../../src/executor.ts";
import { applyPlan } from "../../src/executor.ts";
import { hashTree } from "../../src/hash.ts";

const [, , root, targetDir, killAfter] = process.argv;

await applyPlan({
	root,
	plan: [
		{
			type: "install",
			componentId: "alpha",
			kind: "claude-plugin",
			toVersion: "2.0.0",
			source: { npmName: "draht-claude", resolvedVersion: "2.0.0" },
		},
	],
	materialize: async (_action, stagingComponentDir) => {
		mkdirSync(stagingComponentDir, { recursive: true });
		writeFileSync(`${stagingComponentDir}/payload.txt`, "NEW");
		return {
			targetDir,
			files: await hashTree(stagingComponentDir),
			version: "2.0.0",
			source: { npmName: "draht-claude", resolvedVersion: "2.0.0" },
		};
	},
	afterLiveMove: () => {
		if (killAfter === "after-swap-before-journal") process.kill(process.pid, "SIGKILL");
	},
	checkpoint: (name: CheckpointName) => {
		if (name === killAfter) {
			process.kill(process.pid, "SIGKILL");
			// Unreachable: SIGKILL cannot be caught, blocked or handled.
			while (true) {
				// spin until the kernel tears the process down
			}
		}
	},
});
