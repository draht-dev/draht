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
 * One project declared explicitly in `geist.yaml`'s `projects` map — the
 * "yaml" source of the project registry (spec §3: "registry = yaml ∪
 * workspaceRoots discovery ∪ recents"). The map key is the project's slug,
 * the same identifier spec §9.5's voice/text project qualifier resolves
 * against; `name` defaults to the slug when omitted.
 */
export const ProjectConfigSchema = z.object({
	root: z.string(),
	name: z.string().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * The `geist.yaml` harness config contract (spec §9.1), plus the project
 * registry's declarative sources (spec §3):
 *
 * ```yaml
 * harness:
 *   default: draht
 *   agents:
 *     draht:  { cmd: draht-acp }
 *     claude: { cmd: claude-agent-acp }
 *     codex:  { cmd: codex-acp }
 *     gemini: { cmd: gemini, args: [--experimental-acp] }
 * projects:
 *   fr3n:    { root: /Users/you/dev/fr3n }
 *   kintura: { root: /Users/you/dev/kintura, name: Kintura }
 * workspaceRoots:
 *   - /Users/you/dev
 * ```
 *
 * `projects` and `workspaceRoots` are both optional — a registry can run on
 * workspaceRoots discovery + recents alone, or on explicit `projects` alone.
 * Resolving `root`/`workspaceRoots` entries (tilde expansion, relative paths)
 * is the consumer's job; this schema validates shape only.
 */
export const GeistConfigSchema = z.object({
	harness: z.object({
		default: z.string(),
		agents: z.record(z.string(), AgentLaunchSpecSchema),
	}),
	projects: z.record(z.string(), ProjectConfigSchema).optional(),
	workspaceRoots: z.array(z.string()).optional(),
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
