import { z } from "zod";

/**
 * Component kinds the installer engine manages. `claude-plugin`/`codex-plugin`
 * are payloads copied into the respective host's plugin directory;
 * `global-cli` is the installer's own CLI (or another global binary) managed
 * the same transactional way.
 */
export const ComponentKindSchema = z.enum(["claude-plugin", "codex-plugin", "global-cli"]);
export type ComponentKind = z.infer<typeof ComponentKindSchema>;

/**
 * Where a component's payload came from and what it should resolve to.
 * `integrity` mirrors npm registry `dist.integrity` (ssri-style, typically
 * `sha512-<base64>`) when the source is a published npm package.
 */
export const ComponentSourceSchema = z.object({
	npmName: z.string(),
	resolvedVersion: z.string(),
	integrity: z.string().optional(),
});
export type ComponentSource = z.infer<typeof ComponentSourceSchema>;

/** One file belonging to an installed component, path relative to the component's own target directory (see `paths.ts`). */
export const ComponentFileSchema = z.object({
	path: z.string(),
	sha256: z.string(),
});
export type ComponentFile = z.infer<typeof ComponentFileSchema>;

/**
 * How a component's install was carried out when the engine doesn't manage
 * its files directly (e.g. delegated to `npm install -g`).
 */
export const DelegatedInstallSchema = z.object({
	method: z.string(),
	packageName: z.string(),
});
export type DelegatedInstall = z.infer<typeof DelegatedInstallSchema>;

/**
 * Whether a component's change takes effect immediately, needs the host to
 * reload, needs a fresh session, needs a full restart, or isn't classified.
 * This phase's executor only ever assigns `"unknown"` — host-aware
 * classification is a later phase's job.
 */
export const EffectivenessSchema = z.enum(["live", "after-reload", "next-session", "restart-required", "unknown"]);
export type Effectiveness = z.infer<typeof EffectivenessSchema>;

/** One component's durable, on-disk record: what's installed, from where, and with which files. */
export const ComponentStateSchema = z.object({
	id: z.string(),
	kind: ComponentKindSchema,
	version: z.string(),
	source: ComponentSourceSchema,
	files: z.array(ComponentFileSchema),
	delegated: DelegatedInstallSchema.optional(),
	registered: z.boolean().optional(),
	effectiveness: EffectivenessSchema,
});
export type ComponentState = z.infer<typeof ComponentStateSchema>;

/** How the installed component set is selected: every default component, every available one, or an explicit list. */
export const ProfileModeSchema = z.enum(["default", "full", "explicit"]);
export type ProfileMode = z.infer<typeof ProfileModeSchema>;

export const ProfileSchema = z.object({
	mode: ProfileModeSchema,
	selectors: z.array(z.string()),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * The engine's durable state document (`state.json` under the install root,
 * see `paths.ts`). Schema-versioned so a later phase can migrate forward;
 * `channel` is pinned to `"latest"` for schema v1 (no other channel exists
 * yet). `lastTx` records the most recently committed transaction id, used by
 * `journal.ts#replayState` to anchor journal replay against durable state.
 */
export const InstallStateSchema = z.object({
	schemaVersion: z.literal(1),
	channel: z.literal("latest"),
	profile: ProfileSchema,
	components: z.record(z.string(), ComponentStateSchema),
	lastTx: z.string().optional(),
});
export type InstallState = z.infer<typeof InstallStateSchema>;

const PlanActionBaseSchema = z.object({
	componentId: z.string(),
	kind: ComponentKindSchema,
});

export const InstallActionSchema = PlanActionBaseSchema.extend({
	type: z.literal("install"),
	toVersion: z.string(),
	source: ComponentSourceSchema,
});
export type InstallAction = z.infer<typeof InstallActionSchema>;

export const UpdateActionSchema = PlanActionBaseSchema.extend({
	type: z.literal("update"),
	toVersion: z.string(),
	fromVersion: z.string(),
	source: ComponentSourceSchema,
});
export type UpdateAction = z.infer<typeof UpdateActionSchema>;

export const RemoveActionSchema = PlanActionBaseSchema.extend({
	type: z.literal("remove"),
	fromVersion: z.string(),
});
export type RemoveAction = z.infer<typeof RemoveActionSchema>;

/** Component install is delegated to an external mechanism (e.g. `npm install -g`) rather than the engine's own file swap. */
export const DelegateInstallActionSchema = PlanActionBaseSchema.extend({
	type: z.literal("delegate-install"),
});
export type DelegateInstallAction = z.infer<typeof DelegateInstallActionSchema>;

/** Component uninstall is delegated the same way `delegate-install` delegates install. */
export const DelegateUninstallActionSchema = PlanActionBaseSchema.extend({
	type: z.literal("delegate-uninstall"),
});
export type DelegateUninstallAction = z.infer<typeof DelegateUninstallActionSchema>;

export const PlanActionSchema = z.discriminatedUnion("type", [
	InstallActionSchema,
	UpdateActionSchema,
	RemoveActionSchema,
	DelegateInstallActionSchema,
	DelegateUninstallActionSchema,
]);
export type PlanAction = z.infer<typeof PlanActionSchema>;

/** One journal line (see `journal.ts`): a single event within a transaction, always appended, never rewritten. */
export const JournalEventSchema = z.enum([
	"planned",
	"staged",
	"backed-up",
	"swap-intent",
	"swapped",
	"external-intent",
	"registered",
	"committed",
	"rolled-back",
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;

export const JournalEntrySchema = z.object({
	tx: z.string(),
	seq: z.number().int().nonnegative(),
	at: z.string(),
	event: JournalEventSchema,
	detail: z.unknown().optional(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** One `doctor` diagnostic finding. `repairable` is advisory only in this phase — no repair is implemented yet. */
export const DoctorSeveritySchema = z.enum(["info", "warn", "error"]);
export type DoctorSeverity = z.infer<typeof DoctorSeveritySchema>;

export const DoctorFindingSchema = z.object({
	id: z.string(),
	severity: DoctorSeveritySchema,
	message: z.string(),
	repairable: z.boolean(),
});
export type DoctorFinding = z.infer<typeof DoctorFindingSchema>;
