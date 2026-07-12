/**
 * `@draht/draht-acp` — the ACP agent-side shim wrapping `@draht/coding-agent`'s
 * `AgentSession` (geist spec §6, §17.1). The one package in the geist family
 * allowed to import `@draht/*`, so draht participates in geist — and in any
 * other ACP client — with exactly the privileges of any configured agent.
 *
 * See {@link buildDrahtAcpAgent} / {@link runDrahtAcpAgentStdio}.
 */

export {
	buildDrahtAcpAgent,
	type DrahtAcpAgentConfig,
	type DrahtAcpSessionContext,
	runDrahtAcpAgentStdio,
} from "./draht-acp-agent.ts";
