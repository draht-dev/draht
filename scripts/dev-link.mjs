#!/usr/bin/env bun
/**
 * Build coding-agent from local source and link it globally as "draht" with version "dev".
 * Also links draht-claude globally so `draht-claude install` uses the local plugin source.
 * Run: bun run dev:link
 * Undo: bun run dev:unlink
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CODING_AGENT = resolve(ROOT, "packages/coding-agent");
const DRAHT_CLAUDE = resolve(ROOT, "packages/draht-claude");

const run = (cmd, cwd = ROOT) => {
	console.log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: "inherit" });
};

// 1. Build workspace deps + coding-agent
run("cd packages/tui && bun run build");
run("cd packages/ai && bun run build");
run("cd packages/agent && bun run build");
run("cd packages/coding-agent && bun run build");

// 2. Drop .dev marker (makes VERSION resolve to "dev" at runtime)
writeFileSync(resolve(CODING_AGENT, ".dev"), "");

// 3. Link draht globally
run("bun link", CODING_AGENT);

// 4. Link draht-claude globally — no build needed, cli.mjs runs from source
run("bun link", DRAHT_CLAUDE);

console.log("\ndraht is now linked globally with version 'dev'.");
console.log("draht-claude is now linked globally (installs from local plugin source).");
console.log("Run: draht --version");
console.log("Run: draht-claude --help");
console.log("Undo: bun run dev:unlink");
