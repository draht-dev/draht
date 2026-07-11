import type { AgentSessionConfig } from "@draht/coding-agent";
import type { HarnessSession } from "@draht/geist-core";

/**
 * Creates a `HarnessSession` backed by `@draht/coding-agent`, speaking ACP.
 *
 * `draht-acp` is the one package in the geist family allowed to import
 * `@draht/*` (spec §17.1): a thin shim wrapping `@draht/coding-agent`'s
 * `AgentSession` in ACP so draht participates in geist — and in any other
 * ACP client (Zed, JetBrains) — with exactly the privileges of any other
 * configured agent, no more (spec §6).
 *
 * The shim's ACP wire logic (JSON-RPC bridging between `AgentSession` and
 * the ACP protocol, plus the keyless faux provider used for CI) lands in
 * Phase 35 (M3); see .planning/ROADMAP.md.
 */
export function createDrahtAcpSession(_config: AgentSessionConfig): HarnessSession {
	throw new Error("ACP client lands in Phase 35 (M3) — see .planning/ROADMAP.md");
}
