#!/usr/bin/env bun
/**
 * Remove the .dev marker and unlink both draht and draht-claude.
 * Run: bun run dev:unlink
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CODING_AGENT = resolve(ROOT, "packages/coding-agent");
const DRAHT_CLAUDE = resolve(ROOT, "packages/draht-claude");

const run = (cmd, cwd) => {
	console.log(`$ ${cmd}`);
	try {
		execSync(cmd, { cwd, stdio: "inherit" });
	} catch {
		// Ignore — package may not be linked
	}
};

// 1. Remove the .dev marker so draht reports its real version again
try {
	rmSync(resolve(CODING_AGENT, ".dev"));
	console.log("Removed .dev marker. draht will report its real version.");
} catch {
	console.log("No .dev marker found.");
}

// 2. Unlink both packages globally
run("bun unlink", CODING_AGENT);
run("bun unlink", DRAHT_CLAUDE);

console.log("\nUnlinked draht and draht-claude.");
