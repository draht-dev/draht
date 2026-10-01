#!/usr/bin/env bun
/**
 * Real `draht-acp` launch entry (the package `bin`). Spawned over stdio exactly
 * how a geist launch spec runs an ACP agent: `bun run <this file>`.
 *
 * It resolves the default model from the user's configured `@draht/coding-agent`
 * model registry (real credentials), so no model is hardcoded — the shim's
 * `sessionOptions` seam simply lets `createAgentSession` pick the default model.
 * The keyless CI proof spawns a faux-configured entry instead
 * (`test/fixtures/faux-agent-entry.ts`), which runs this same shim code.
 */

import { runDrahtAcpAgentStdio } from "./draht-acp-agent.ts";

if (import.meta.main) {
	runDrahtAcpAgentStdio({
		name: "draht-acp",
		// No explicit model: createAgentSession resolves the default from settings
		// and the real model registry (deployment path, requires credentials).
		sessionOptions: () => ({}),
	});
}
