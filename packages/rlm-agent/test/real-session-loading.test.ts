// **Mandatory** proof, per .planning/phases/29-agent-cli-integration/
// 29-01-PLAN.md's "IMPORTANT" section: `@draht/rlm-agent` must actually be
// reachable through the REAL, settings-driven package-resolution path, not
// just testable in isolation against a mock `ExtensionAPI` (that's
// `test/extension.test.ts`, and Phase 23 already demonstrated exactly how
// far "tested in isolation" can diverge from "actually loaded by a real
// session": `core/builtins/subagent.ts` had full isolated test coverage but
// was never referenced by any real session-construction path).
//
// This builds a session the exact way `@draht/coding-agent`'s own CLI does
// -- `createAgentSessionServices` -> `createAgentSessionFromServices` -- with
// a `SettingsManager` whose global `settings.json` configures a **local
// package source** pointing at this repo's real `packages/rlm-agent`
// directory (the same directory this test file lives in, one level up; not
// a copied fixture). The local-package-source string format and resolution
// path are read directly from `packages/coding-agent/src/core/
// package-manager.ts`:
//   - `DefaultPackageManager.parseSource()` treats any source string that
//     isn't `npm:`/a git URL (see `utils/paths.ts`'s `isLocalPath`) as
//     `{ type: "local", path: source }`.
//   - `resolveLocalExtensionSource()` resolves that path (absolute paths
//     resolve as-is, regardless of scope base dir -- see `utils/paths.ts`'s
//     `resolvePath`), finds it's a directory, and -- since our
//     `package.json` has no per-package resource filter object, just the
//     bare path string -- calls `collectPackageResources()`, which reads the
//     package's `"pi": { "extensions": [...] }` manifest field and resolves
//     each declared entry relative to the package root.
// So an absolute path to `packages/rlm-agent` in `settings.json`'s
// `packages` array is the exact real-world shape a user's
// `draht install /abs/path/to/packages/rlm-agent -l` (or an equivalent
// global install) would persist -- see `test/package-command-paths.test.ts`
// in `@draht/coding-agent` for the same convention proven against `draht
// install`/`draht remove` directly.
//
// This test only asserts the extension's *tools and commands are
// registered* in the real running session -- it deliberately never calls
// `rlm_query`'s `execute()` or the `/rlm` command's handler, since those
// spawn a real OS-sandboxed python3 subprocess and would need a real model
// provider API key; that behavior is covered by `@draht/rlm`'s own test
// suite (`packages/rlm/test/*`) and is out of scope for this "is it
// actually loaded" proof.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@draht/ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@draht/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The real, on-disk `packages/rlm-agent` directory -- this test file's parent. */
const RLM_AGENT_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

describe("regression: @draht/rlm-agent is loadable through the real, settings-driven package-resolution path", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rlm-agent-real-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createRealSessionWithRlmAgentInstalled() {
		// Real settings-driven local package source: an absolute path string in
		// the global settings.json's `packages` array -- precisely what
		// `DefaultPackageManager` reads in `resolve()`, not a test-only bypass
		// like passing `resourceLoaderOptions.extensionFactories` directly.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [RLM_AGENT_PACKAGE_DIR] }));

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		return session;
	}

	it("registers the rlm_query tool in session.getAllTools()", async () => {
		const session = await createRealSessionWithRlmAgentInstalled();
		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			expect(toolNames).toContain("rlm_query");
		} finally {
			session.dispose();
		}
	});

	it("registers the /rlm slash command in the real, running session", async () => {
		const session = await createRealSessionWithRlmAgentInstalled();
		try {
			const command = session.extensionRunner.getCommand("rlm");
			expect(command).toBeDefined();
			expect(command?.description).toContain("Usage: /rlm <input> <query>");

			const registered = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
			expect(registered).toContain("rlm");
		} finally {
			session.dispose();
		}
	});

	it("does NOT register rlm_query or /rlm when packages/rlm-agent is not configured (sanity check on the assertion itself)", async () => {
		// No settings.json written -- packages array is empty. Proves the
		// preceding two tests are actually exercising package resolution, not
		// asserting on tools/commands that would be present unconditionally.
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("rlm_query");
			expect(session.extensionRunner.getCommand("rlm")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});
