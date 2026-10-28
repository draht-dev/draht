import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		/** Per-run directory holding the emitted-build lock and marker. See test/emitted-build.ts. */
		emittedBuildRunDir: string;
	}
}

// One directory per vitest run, created before any worker starts, so every test file that drives
// the emitted binary shares a single build of dist/ instead of rebuilding it concurrently.
export default function setup(project: TestProject): () => void {
	const runDir = mkdtempSync(join(tmpdir(), "draht-ca-emitted-build-"));
	project.provide("emittedBuildRunDir", runDir);
	return () => rmSync(runDir, { recursive: true, force: true });
}
