import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SituationPrompt } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

import { type AcpHarnessSession, createAcpHarnessSession } from "../../src/acp-harness-session.js";

/**
 * Non-CI network smoke test (spec §16 M3: `smoke:harness -- claude`; R35-M3.4).
 * Everything else in this package proves `geist-acp` against the deterministic
 * in-repo mock agent; this is the one test that proves the real, registry-pinned
 * `claude-agent-acp` launch spec (spec §9.1) actually round-trips over stdio.
 * That needs a real network connection and the runner's own Claude auth, so —
 * unlike the rest of this package's suite — it is explicitly NOT required to
 * pass automatically in CI (spec §16 M3 says so verbatim):
 *
 * - Run it deliberately via `npm run smoke:harness` (a dedicated script — see
 *   `package.json` — separate from this package's plain `test` script).
 * - Even then, and even if this file is swept up by an ordinary `bun test` run
 *   (e.g. the root `npm run test --workspaces` chain `npm run check` depends
 *   on), the single test below self-skips unless BOTH a real Anthropic API key
 *   and the `claude-agent-acp` binary are actually resolvable — mirroring
 *   `packages/geist/test/voice/transcribe.test.ts`'s "skip gracefully when the
 *   real toolchain isn't installed" pattern. A missing local credential/binary
 *   is not a product regression, so a normal green run never needs either.
 */

const claudeAgentAcpBinary = Bun.which("claude-agent-acp");
const hasAnthropicApiKey =
	typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
const canRunRealClaudeHarness = claudeAgentAcpBinary !== null && hasAnthropicApiKey;

describe("claude-agent-acp harness smoke test", () => {
	test.skipIf(!canRunRealClaudeHarness)(
		"dispatches a real prompt against the real claude-agent-acp and completes a turn",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "geist-acp-claude-smoke-"));
			const launchSpec: AgentLaunchSpec = { cmd: "claude-agent-acp" };
			let session: AcpHarnessSession | undefined;

			try {
				session = await createAcpHarnessSession(launchSpec, cwd);
				expect(session.status).toBe("running");
				expect(typeof session.pid).toBe("number");

				const prompt: SituationPrompt = {
					blocks: [{ type: "text", text: "Reply with exactly one word: pong" }],
				};
				// `dispatch()` only resolves once the real agent's `session/update`
				// stream reports a `stop` update (acp-harness-session.ts's `dispatch`
				// loop) — so resolving here IS the proof a real response came back
				// over the wire from the real claude-agent-acp subprocess.
				await session.dispatch(prompt);

				expect(["running", "awaiting_review"]).toContain(session.status);
			} finally {
				if (session) await session.stop();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
