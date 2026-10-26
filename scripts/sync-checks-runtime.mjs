#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { syncBudgetRuntime } from "./sync-budgets-runtime.mjs";

let drifted = false;
for (const file of ["checks-runtime.cjs", "git-safety.cjs"]) {
	const source = readFileSync(new URL(`../packages/coding-agent/hooks/checks/${file}`, import.meta.url), "utf8");
	for (const name of ["draht-claude", "draht-codex"]) {
		const target = new URL(`../packages/${name}/scripts/${file}`, import.meta.url);
		let existing;
		try { existing = readFileSync(target, "utf8"); } catch { /* new payload */ }
		if (existing === source) continue;
		if (process.argv.includes("--check")) {
			console.error(`Runtime drift: ${fileURLToPath(target)}`);
			drifted = true;
		} else writeFileSync(target, source);
	}
}
if (!await syncBudgetRuntime({ check: process.argv.includes("--check") })) drifted = true;
if (drifted) process.exitCode = 1;
else console.log("Checks runtime synchronized across all three hosts");
