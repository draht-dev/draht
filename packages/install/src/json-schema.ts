/**
 * The machine-readable output contract, expressed once and checked in twice.
 *
 * Every `--json` document and every NDJSON record this CLI can write is
 * described here as a *strict* schema: an unexpected key is a validation
 * failure, not an ignored extra. `schemas/*.schema.json` in this package is the
 * JSON Schema rendering of exactly these definitions, kept in lockstep by
 * `test/json-contract.test.ts`, which also validates real CLI output against
 * them. That is what makes the contract unable to drift silently — a change to
 * an emitted shape fails either validation, the schema-artifact snapshot, or
 * the observed-shape snapshot.
 *
 * Zod v4 is used here (rather than the v3 API the durable-state schemas in
 * `types.ts` use) purely because it can render JSON Schema; the two coexist
 * without interacting.
 */
import { toJSONSchema, z } from "zod/v4";
import { KNOWN_KINDS } from "./catalog.ts";
import { JSON_SCHEMA_VERSION } from "./json.ts";
import { packageRoot } from "./version.ts";

const schemaVersion = z.literal(JSON_SCHEMA_VERSION);
const ok = z.literal(true);

const componentKind = z.enum(KNOWN_KINDS);
const effectiveness = z.enum(["live", "after-reload", "next-session", "restart-required", "unknown"]);
const driftStatus = z.enum(["clean", "drifted", "missing", "delegated", "unknown"]);
const doctorSeverity = z.enum(["info", "warn", "error"]);
const profileMode = z.enum(["default", "full", "explicit"]);
const channel = z.literal("latest");

/** Mirrors `ComponentSource` in `types.ts` — how a component's payload was resolved. */
const componentSource = z.strictObject({
	npmName: z.string(),
	resolvedVersion: z.string(),
	integrity: z.string().optional(),
});

/**
 * Mirrors `PlanAction` in `types.ts`, which is what `serializeAction` spreads
 * verbatim into plan documents and apply summaries.
 */
const planAction = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("install"),
		componentId: z.string(),
		kind: componentKind,
		toVersion: z.string(),
		source: componentSource,
	}),
	z.strictObject({
		type: z.literal("update"),
		componentId: z.string(),
		kind: componentKind,
		toVersion: z.string(),
		fromVersion: z.string(),
		source: componentSource,
	}),
	z.strictObject({
		type: z.literal("remove"),
		componentId: z.string(),
		kind: componentKind,
		fromVersion: z.string(),
	}),
	z.strictObject({ type: z.literal("delegate-install"), componentId: z.string(), kind: componentKind }),
	z.strictObject({ type: z.literal("delegate-uninstall"), componentId: z.string(), kind: componentKind }),
]);

/** Mirrors `BlockedEntry` in `plan.ts`. The only blocking reason this release produces is a refused downgrade. */
const blockedEntry = z.strictObject({
	componentId: z.string(),
	reason: z.literal("downgrade"),
	from: z.string(),
	to: z.string(),
});

/** Mirrors `SelectionResult["skipped"]` in `select.ts`. */
const skippedEntry = z.strictObject({ id: z.string(), reason: z.literal("host-absent"), host: z.string() });

/** Mirrors `SelectionResult["hostMissing"]` in `select.ts`. */
const hostMissingEntry = z.strictObject({ id: z.string(), host: z.string() });

/** Mirrors `StatusComponent` in `engine.ts`. */
const statusComponent = z.strictObject({
	id: z.string(),
	kind: componentKind,
	version: z.string(),
	effectiveness,
	drift: driftStatus,
	delegated: z.strictObject({ method: z.string(), packageName: z.string() }).optional(),
	targetDir: z.string().nullable(),
});

/** Mirrors `DoctorFinding` in `types.ts`. */
const doctorFinding = z.strictObject({
	id: z.string(),
	severity: doctorSeverity,
	message: z.string(),
	repairable: z.boolean(),
});

/** `--version --json`, emitted by both bins (`run-cli.ts`). */
const versionDocument = z
	.strictObject({
		schemaVersion,
		command: z.literal("version"),
		bin: z.enum(["draht-install", "draht-init"]),
		version: z.string(),
	})
	.meta({
		title: "draht-install --version --json",
		description: "The single document `--version --json` writes, from either bin.",
	});

/** `plan --json` (`commands.ts#commandPlan`). */
const planDocument = z
	.strictObject({
		schemaVersion,
		command: z.literal("plan"),
		ok,
		channel,
		profile: profileMode,
		actions: z.array(planAction),
		blocked: z.array(blockedEntry),
		skipped: z.array(skippedEntry),
		hostMissing: z.array(hostMissingEntry),
	})
	.meta({
		title: "draht-install plan --json",
		description:
			"The single document `plan --json` writes. Exit code 2 means `actions` is non-empty; exit code 3 means `blocked` is.",
	});

/** `status --json` (`commands.ts#commandStatus`). */
const statusDocument = z
	.strictObject({
		schemaVersion,
		command: z.literal("status"),
		ok,
		channel,
		root: z.string(),
		components: z.array(statusComponent),
		pendingChanges: z.number().int().nonnegative(),
	})
	.meta({
		title: "draht-install status --json",
		description:
			"The single document `status --json` writes. `pendingChanges` counts components whose drift is `drifted` or `missing`; with --check a non-zero count exits 2.",
	});

/** `doctor --json` (`commands.ts#commandDoctor`). */
const doctorDocument = z
	.strictObject({
		schemaVersion,
		command: z.literal("doctor"),
		ok,
		root: z.string(),
		findings: z.array(doctorFinding),
	})
	.meta({
		title: "draht-install doctor --json",
		description:
			"The single document `doctor --json` writes. Any finding with severity `error` makes the command exit 1.",
	});

/**
 * The failure document (`json.ts#jsonError`). Read verbs write it as one
 * pretty-printed document; mutating verbs write it as one NDJSON line, so it
 * is also a member of every stream schema below.
 */
const errorDocument = z
	.strictObject({
		schemaVersion,
		ok: z.literal(false),
		command: z.string(),
		error: z.strictObject({
			code: z.string(),
			message: z.string(),
			detail: z.record(z.string(), z.unknown()).optional(),
		}),
	})
	.meta({
		title: "draht-install --json error document",
		description:
			"Emitted instead of a success document when a command fails. `error.code` is the machine-readable discriminator; `error.message` is prose that may change between releases and must not be parsed.",
	});

/** Every `PlanAction` discriminator, as it appears in progress records. */
const actionType = z.enum(["install", "update", "remove", "delegate-install", "delegate-uninstall"]);

/** Mirrors `ApplyEvent` in `engine.ts`, stamped with `schemaVersion` and `command` by the emitters. */
function applyEvents(command: z.ZodType) {
	return [
		z.strictObject({
			schemaVersion,
			command,
			event: z.literal("action-start"),
			componentId: z.string(),
			type: actionType,
		}),
		z.strictObject({
			schemaVersion,
			command,
			event: z.literal("action-done"),
			componentId: z.string(),
			type: actionType,
			version: z.string().optional(),
			notes: z.array(z.string()),
		}),
		z.strictObject({
			schemaVersion,
			command,
			event: z.literal("blocked"),
			componentId: z.string(),
			reason: z.string(),
		}),
		z.strictObject({
			schemaVersion,
			command,
			event: z.literal("recovered"),
			transactions: z.array(z.string()),
			notes: z.array(z.string()),
		}),
	] as const;
}

const applyCommand = z.enum(["install", "update"]);

/** Every record `install --json` / `update --json` can write, one per line (`commands.ts#commandApply`). */
const applyStream = z
	.union([
		...applyEvents(applyCommand),
		// Dry run: nothing was written and nothing was resolved against the registry.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: applyCommand,
			ok,
			dryRun: z.literal(true),
			actions: z.array(planAction),
			blocked: z.array(blockedEntry),
		}),
		// Nothing to do: the plan resolved to no actions, so no transaction ran.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: applyCommand,
			ok,
			actions: z.array(planAction),
			blocked: z.array(blockedEntry),
		}),
		// A transaction ran: `tx` names it and `actions` is what it actually applied.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: applyCommand,
			ok,
			tx: z.string().optional(),
			actions: z.array(planAction),
			blocked: z.array(blockedEntry),
			notes: z.array(z.string()),
		}),
		errorDocument,
	])
	.meta({
		title: "draht-install install|update --json (NDJSON stream)",
		description:
			"One JSON object per line. Progress records come first, then exactly one `summary` record — or one error document if the command failed.",
	});

const uninstallCommand = z.literal("uninstall");

/** Every record `uninstall --json` can write, one per line (`commands.ts#commandUninstall`). */
const uninstallStream = z
	.union([
		...applyEvents(uninstallCommand),
		// Nothing to do, or a dry run: no transaction, so no `tx` and no notes.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: uninstallCommand,
			ok,
			actions: z.array(planAction),
		}),
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: uninstallCommand,
			ok,
			dryRun: z.literal(true),
			actions: z.array(planAction),
		}),
		// A transaction ran. Uninstall never reports `blocked`: it acts only on
		// what durable state already records.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			command: uninstallCommand,
			ok,
			tx: z.string().optional(),
			actions: z.array(planAction),
			notes: z.array(z.string()),
		}),
		errorDocument,
	])
	.meta({
		title: "draht-install uninstall --json (NDJSON stream)",
		description:
			"One JSON object per line. Progress records come first, then exactly one `summary` record — or one error document if the command failed.",
	});

const initCommand = z.literal("init");

/** Every record `draht-init --json` can write, one per line (`init.ts#runInit`). */
const initStream = z
	.union([
		...applyEvents(initCommand),
		// Dry run: neither components nor the scaffold were touched.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			ok,
			dryRun: z.literal(true),
			project: z.string(),
			actions: z.array(planAction),
			command: initCommand,
		}),
		// One draht-tools subprocess is about to run, with the exact argv it is given.
		z.strictObject({
			schemaVersion,
			event: z.literal("scaffold-start"),
			argv: z.array(z.string()),
			command: initCommand,
		}),
		// The project was scaffolded; `handoff` is the command the operator runs next.
		z.strictObject({
			schemaVersion,
			event: z.literal("summary"),
			ok,
			project: z.string(),
			handoff: z.string(),
			command: initCommand,
		}),
		errorDocument,
	])
	.meta({
		title: "draht-init --json (NDJSON stream)",
		description:
			"One JSON object per line: component-apply progress, then a `scaffold-start` per draht-tools invocation, then exactly one `summary` — or one error document if the command failed.",
	});

/**
 * Every machine-readable contract this CLI publishes, keyed by the name of its
 * checked-in schema file. Read verbs map to a single-document schema; mutating
 * verbs map to a stream schema every emitted line must satisfy.
 */
export const JSON_CONTRACTS = {
	version: versionDocument,
	plan: planDocument,
	status: statusDocument,
	doctor: doctorDocument,
	error: errorDocument,
	"apply-stream": applyStream,
	"uninstall-stream": uninstallStream,
	"init-stream": initStream,
} as const;

export type JsonContractName = keyof typeof JSON_CONTRACTS;

export const JSON_CONTRACT_NAMES = Object.keys(JSON_CONTRACTS).sort() as JsonContractName[];

/**
 * Validates one emitted document or NDJSON record against its contract.
 * Returns `null` when it conforms, or a human-readable report of every
 * violation. Consumers can use this to fail fast on an installer whose output
 * contract they do not understand.
 */
export function checkJsonContract(name: JsonContractName, value: unknown): string | null {
	const schema: z.ZodType = JSON_CONTRACTS[name];
	const result = schema.safeParse(value);
	if (result.success) return null;
	return `${name} contract violation: ${JSON.stringify(result.error.issues, null, 2)}`;
}

/** Absolute path of the checked-in JSON Schema artifact for one contract. */
export function jsonSchemaPath(name: JsonContractName): string {
	return `${packageRoot()}/schemas/${name}.schema.json`;
}

/** The JSON Schema (draft 2020-12) rendering of one contract, exactly as its checked-in artifact stores it. */
export function renderJsonSchema(name: JsonContractName): string {
	return `${JSON.stringify(toJSONSchema(JSON_CONTRACTS[name], { target: "draft-2020-12" }), null, 2)}\n`;
}
