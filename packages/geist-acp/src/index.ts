import type { HarnessSession } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

/**
 * Spawns a `HarnessSession` for one configured ACP agent (spec §6, §7):
 * launches `launchSpec.cmd` as a stdio subprocess in `cwd`, performs the ACP
 * capability handshake, and normalizes ACP events (tool calls, plan updates,
 * permission requests) into the harness-agnostic `HarnessSession` port that
 * `geist-core` consumes.
 *
 * `geist-acp` is "the only code that knows ACP wire shapes" (spec §6) — none
 * of that wire logic exists yet. The ACP client, subprocess lifecycle,
 * capability handshake, and event normalization land in Phase 35 (M3); see
 * .planning/ROADMAP.md.
 */
export function createAcpHarnessSession(_launchSpec: AgentLaunchSpec, _cwd: string): HarnessSession {
	throw new Error("ACP client lands in Phase 35 (M3) — see .planning/ROADMAP.md");
}
