import { z } from "zod";

/**
 * Component ids are used to build filesystem paths and appear verbatim in
 * journal/state documents, so the grammar is deliberately narrow: lowercase
 * alphanumerics and single hyphens only. This is what makes `../escape`,
 * absolute paths, and NUL-bearing ids unrepresentable rather than merely
 * checked-for later.
 */
export const COMPONENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Kinds this engine ships an adapter for. A catalog entry may name another kind; selecting it fails closed. */
export const KNOWN_KINDS = ["claude-plugin", "codex-plugin", "global-cli"] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];

/**
 * One catalog entry.
 *
 * `kind` is intentionally a free string rather than the `KNOWN_KINDS` enum:
 * the adjudicated contract is that adding a future component of a future kind
 * is a pure data change, and that an unknown kind fails **only when selected**.
 * A strict enum here would instead reject the whole catalog at load time.
 */
export const CatalogComponentSchema = z.object({
	id: z.string().regex(COMPONENT_ID_PATTERN, "component id must be lowercase alphanumeric with single hyphens"),
	kind: z.string().min(1),
	/** npm package the payload is resolved from. */
	npmName: z.string().min(1),
	description: z.string().min(1),
	/** Channels this component publishes to. Only `latest` exists in this release. */
	channels: z.array(z.string().min(1)).min(1),
	/** Host CLI that must be on PATH for this component to be useful, or `null` when it stands alone. */
	requiresHost: z.string().min(1).nullable(),
	/** Whether the detection-based default profile considers this component at all. */
	defaultProfile: z.boolean(),
});
export type CatalogComponent = z.infer<typeof CatalogComponentSchema>;

export const CatalogSchema = z.array(CatalogComponentSchema);

/**
 * The shipped catalog. Every entry is data — the engine holds no per-package
 * branching; behavior comes from `kind` via the adapter table.
 */
const SHIPPED_CATALOG: unknown[] = [
	{
		id: "claude-plugin",
		kind: "claude-plugin",
		npmName: "draht-claude",
		description: "Draht workflows as a Claude Code plugin (skills, commands, agents, hooks).",
		channels: ["latest"],
		requiresHost: "claude",
		defaultProfile: true,
	},
	{
		id: "codex-plugin",
		kind: "codex-plugin",
		npmName: "draht-codex",
		description: "Draht workflows as a Codex plugin (skills, commands, agents, hooks).",
		channels: ["latest"],
		requiresHost: "codex",
		defaultProfile: true,
	},
	{
		id: "coding-agent",
		kind: "global-cli",
		npmName: "@draht/coding-agent",
		description: "The draht coding agent CLI, installed globally through the detected package manager.",
		// A global-cli component is installed by npm; without npm on PATH there
		// is no mechanism to install it, so the default profile must not select
		// it. This is what makes an empty default profile — and therefore
		// `--fail-on-empty` — reachable rather than theoretical.
		channels: ["latest"],
		requiresHost: "npm",
		defaultProfile: false,
	},
	{
		id: "installer",
		kind: "global-cli",
		npmName: "@draht/install",
		description: "This installer engine itself, so draht-install and draht-init stay current.",
		channels: ["latest"],
		requiresHost: "npm",
		defaultProfile: true,
	},
];

/** Parses and returns the shipped catalog. Throws if the shipped data ever stops matching its own schema. */
export function loadCatalog(): CatalogComponent[] {
	const result = CatalogSchema.safeParse(SHIPPED_CATALOG);
	if (!result.success) {
		throw new Error(`shipped component catalog is invalid: ${result.error.message}`);
	}
	return result.data;
}

/** Whether `kind` has a shipped adapter. */
export function isKnownKind(kind: string): kind is KnownKind {
	return (KNOWN_KINDS as readonly string[]).includes(kind);
}
