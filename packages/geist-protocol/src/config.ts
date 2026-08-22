import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * A single ACP launch spec for one configured agent (spec §9.1, §6):
 * how to spawn the agent's ACP subprocess.
 *
 * `cmd` must be ABSOLUTE (R36-SPAWN.2). A bare name like `draht-acp` is a PATH
 * lookup, and PATH belongs to whoever last wrote the daemon's environment — the
 * one input the spawn path is built to never consult. The refinement here is a
 * CONVENIENCE that fails a bad registry early with a readable message; it is
 * NOT the enforcement. See the module comment on {@link GeistConfigSchema}.
 *
 * `credentialEnv` names the environment variables THIS harness may receive.
 * Absent means "none beyond the built-in minimum": handing every provider key to
 * every harness is the default this field exists to remove, so an omitted
 * `credentialEnv` must never be read as "all of them".
 */
export const AgentLaunchSpecSchema = z.object({
	cmd: z.string().refine((value) => isAbsolute(value), {
		message: "cmd must be an absolute path (a bare command name would be resolved through PATH)",
	}),
	args: z.array(z.string()).optional(),
	credentialEnv: z.array(z.string()).optional(),
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
 *     draht:  { cmd: /usr/local/bin/draht-acp }
 *     claude: { cmd: /usr/local/bin/claude-agent-acp, credentialEnv: [ANTHROPIC_API_KEY] }
 *     codex:  { cmd: /usr/local/bin/codex-acp }
 *     gemini: { cmd: /usr/local/bin/gemini, args: [--experimental-acp] }
 * projects:
 *   fr3n:    { root: /Users/you/dev/fr3n }
 *   kintura: { root: /Users/you/dev/kintura, name: Kintura }
 * workspaceRoots:
 *   - /Users/you/dev
 * approvedRoots:
 *   - /Users/you/dev
 * ```
 *
 * `projects` and `workspaceRoots` are both optional — a registry can run on
 * workspaceRoots discovery + recents alone, or on explicit `projects` alone.
 * Resolving `root`/`workspaceRoots` entries (tilde expansion, relative paths)
 * is the consumer's job; this schema validates shape only.
 *
 * `approvedRoots` is the set of canonical directories a spawn may enter
 * (R36-SPAWN.3). It lives here so an operator declares it once, in the file only
 * they can write.
 *
 * THIS SCHEMA IS SHAPE VALIDATION AND NOTHING MORE, and the absolute-path
 * refinement on `AgentLaunchSpecSchema.cmd` does not change that. A schema
 * cannot know which roots are approved on this machine, cannot stat anything,
 * and — decisively — validation is not race-safe: whatever it concluded about a
 * path was true at parse time and says nothing about the moment of `exec`. The
 * enforcement is two-sided and lives elsewhere: the resolver REFUSES at load,
 * and the path walk in the spawn primitive RE-VERIFIES at launch. Deleting the
 * refinement would cost a readable error message; deleting either of those would
 * cost the requirement.
 */
export const GeistConfigSchema = z.object({
	harness: z.object({
		default: z.string(),
		agents: z.record(z.string(), AgentLaunchSpecSchema),
	}),
	projects: z.record(z.string(), ProjectConfigSchema).optional(),
	workspaceRoots: z.array(z.string()).optional(),
	approvedRoots: z.array(z.string()).optional(),
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
