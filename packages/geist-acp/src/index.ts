/**
 * `geist-acp` — the ACP client and `HarnessSession` implementation, "the only
 * code that knows ACP wire shapes" (spec §6). It launches a configured agent's
 * stdio subprocess, performs the ACP capability handshake, and normalizes ACP
 * events (tool calls, plan updates, permission requests) into the
 * harness-agnostic `HarnessSession` port that `geist-core` consumes (Phase 35 /
 * M3; see .planning/ROADMAP.md).
 */

export {
	type AcpHarnessSession,
	createAcpHarnessSession,
	type PermissionRequestEvent,
	type PlanUpdateEvent,
	type ToolCallEvent,
} from "./acp-harness-session.js";
