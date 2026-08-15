#!/usr/bin/env bun
/**
 * Remove the .dev marker and unlink draht, draht-claude, draht-codex, and x-markdown.
 * Run: bun run dev:unlink
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CODING_AGENT = resolve(ROOT, "packages/coding-agent");
const DRAHT_CLAUDE = resolve(ROOT, "packages/draht-claude");
const DRAHT_CODEX = resolve(ROOT, "packages/draht-codex");
const X_MARKDOWN = resolve(ROOT, "packages/x-markdown");

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

// 2. Unlink packages globally
run("bun unlink", CODING_AGENT);
run("bun unlink", DRAHT_CLAUDE);
run("bun unlink", DRAHT_CODEX);
run("bun unlink", X_MARKDOWN);

console.log("\nUnlinked draht, draht-claude, draht-codex, and x-markdown.");
