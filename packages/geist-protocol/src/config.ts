import { z } from "zod";

/**
 * A single ACP launch spec for one configured agent (spec §9.1, §6):
 * how to spawn the agent's ACP subprocess.
 */
export const AgentLaunchSpecSchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).optional(),
});
export type AgentLaunchSpec = z.infer<typeof AgentLaunchSpecSchema>;

/**
 * The `geist.yaml` harness config contract (spec §9.1):
 *
 * ```yaml
 * harness:
 *   default: draht
 *   agents:
 *     draht:  { cmd: draht-acp }
 *     claude: { cmd: claude-agent-acp }
 *     codex:  { cmd: codex-acp }
 *     gemini: { cmd: gemini, args: [--experimental-acp] }
 * ```
 */
export const GeistConfigSchema = z.object({
	harness: z.object({
		default: z.string(),
		agents: z.record(z.string(), AgentLaunchSpecSchema),
	}),
});
export type GeistConfig = z.infer<typeof GeistConfigSchema>;

/**
 * Parses and validates raw `geist.yaml` (or `--config` / `~/.geist/config.yaml`)
 * content against {@link GeistConfigSchema}. Throws a readable error listing
 * every validation issue found.
 */
export function parseGeistConfig(raw: unknown): GeistConfig {
	const result = GeistConfigSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid geist config: ${issues}`);
	}
	return result.data;
}
