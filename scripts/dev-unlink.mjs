#!/usr/bin/env bun
/**
 * Remove the .dev marker to restore normal version reporting.
 * Run: bun run dev:unlink
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const marker = resolve(import.meta.dirname, "..", "packages/coding-agent/.dev");

try {
	rmSync(marker);
	console.log("Removed .dev marker. draht will report its real version.");
} catch {
	console.log("No .dev marker found, nothing to do.");
}
