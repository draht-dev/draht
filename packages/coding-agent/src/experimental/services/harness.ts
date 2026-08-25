import { type AgentHarness, type AgentLane, defineService } from "@draht/agent-core";

export const Harness = defineService<AgentHarness>("pi.local.harness");
export const Lane = defineService<AgentLane>("pi.local.lane");
