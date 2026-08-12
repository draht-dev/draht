import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "./adapters/index.ts";
import type { AdapterComponent, AdapterContext } from "./adapters/types.ts";
import type { Channel } from "./args.ts";
import type { CatalogComponent } from "./catalog.ts";
import type { DetectionResult } from "./detect.ts";
import { BlockedError, CliError } from "./errors.ts";
import { ApplyError, applyPlan, type MaterializedComponent } from "./executor.ts";
import { hashTree } from "./hash.ts";
import type { HostRunner } from "./host.ts";
import { acquireLock } from "./lock.ts";
import { type BlockedEntry, computePlan, type DesiredComponent } from "./plan.ts";
import { assessCrashedTransactions, recoverCrashedTransactions } from "./recovery.ts";
import { assertNoSymlinkPivot, assertSafeComponentId, assertSafeRelativePath, assertSafeTarget } from "./safety.ts";
import type { SelectionResult } from "./select.ts";
import { materializeFromCache } from "./sources/cache.ts";
import type { RegistryClient, ResolvedPackage } from "./sources/types.ts";
import { loadState } from "./state.ts";
import type { ComponentState, InstallState, PlanAction } from "./types.ts";

export interface EngineDeps {
	root: string;
	home: string;
	env: NodeJS.ProcessEnv;
	catalog: CatalogComponent[];
	registry: RegistryClient;
	runHost: HostRunner;
	detection: DetectionResult;
	channel: Channel;
	signal?: AbortSignal;
}

export interface EnginePlan {
	actions: PlanAction[];
	blocked: BlockedEntry[];
	selection: SelectionResult;
	/** Resolved package descriptor per component id, reused by `apply` so a plan and its application agree. */
	resolved: Map<string, ResolvedPackage>;
}

export type ApplyEvent =
	| { event: "action-start"; componentId: string; type: PlanAction["type"] }
	| { event: "action-done"; componentId: string; type: PlanAction["type"]; version?: string; notes: string[] }
	| { event: "blocked"; componentId: string; reason: string }
	| { event: "recovered"; transactions: string[]; notes: string[] };

export interface ApplyOutcome {
	tx?: string;
	applied: PlanAction[];
	blocked: BlockedEntry[];
	notes: string[];
	state: InstallState;
}

/**
 * Per-component drift, computed against the durable file manifest.
 *
 * `delegated` — an external package manager owns the bytes, so there is no
 * manifest to compare. `unknown` — this engine build has no catalog entry for
 * the component and therefore cannot resolve its target; reporting `clean`
 * there would be a claim the engine cannot support.
 */
export type DriftStatus = "clean" | "drifted" | "missing" | "delegated" | "unknown";

export interface StatusComponent {
	id: string;
	kind: string;
	version: string;
	effectiveness: string;
	drift: DriftStatus;
	delegated?: { method: string; packageName: string };
	targetDir: string | null;
}

/**
 * Ties the pure pieces together: catalog + selection produce a desired set,
 * the registry resolves versions, `computePlan` diffs against durable state
 * and disk, and the executor applies the result under a lock.
 *
 * The engine owns no host knowledge and no package-specific behavior — both
 * live behind the kind-keyed adapter table.
 */
export class Engine {
	constructor(private readonly deps: EngineDeps) {}

	private adapterContext(): AdapterContext {
		return {
			root: this.deps.root,
			home: this.deps.home,
			env: this.deps.env,
			runHost: this.deps.runHost,
			hostPath: (name) => this.deps.detection.hosts[name]?.path ?? null,
		};
	}

	private componentById(id: string): CatalogComponent {
		const component = this.deps.catalog.find((candidate) => candidate.id === id);
		if (!component) throw new CliError("unknown-component", `component "${id}" is not in the shipped catalog`);
		return component;
	}

	private adapterComponent(component: CatalogComponent): AdapterComponent {
		return { id: component.id, kind: component.kind, npmName: component.npmName };
	}

	/** The directory a component's payload owns, validated against every target-safety rule. */
	targetDirFor(component: CatalogComponent): string | null {
		const adapter = adapterFor(component.kind);
		const target = adapter.targetDir(this.adapterContext(), this.adapterComponent(component));
		if (target === null) return null;
		assertSafeTarget(target, { home: this.deps.home, installRoot: this.deps.root });
		return target;
	}

	/**
	 * Resolves the desired versions and diffs them against reality.
	 *
	 * `force` turns a clean, up-to-date component into an explicit reinstall;
	 * without it an already-satisfied component produces no action at all.
	 */
	async resolvePlan(selection: SelectionResult, options: { force?: boolean } = {}): Promise<EnginePlan> {
		const state = loadState(this.deps.root);
		const resolved = new Map<string, ResolvedPackage>();
		const desired: DesiredComponent[] = [];

		for (const component of selection.components) {
			assertSafeComponentId(component.id);
			if (!component.channels.includes(this.deps.channel)) {
				throw new CliError(
					"channel-missing",
					`component "${component.id}" does not publish to the "${this.deps.channel}" channel`,
				);
			}
			const pkg = await this.deps.registry.resolve(component.npmName, this.deps.channel);
			resolved.set(component.id, pkg);
			desired.push({
				id: component.id,
				kind: component.kind as DesiredComponent["kind"],
				version: pkg.version,
				source: { npmName: component.npmName, resolvedVersion: pkg.version, integrity: pkg.integrity },
			});
		}

		const diskFiles = (componentId: string): Array<{ path: string; sha256: string }> | null => {
			const recorded = state.components[componentId];
			if (!recorded) return null;
			// Delegated components have no engine-owned files; their recorded empty
			// manifest is the truth, so report it unchanged rather than hashing a
			// directory the engine does not own.
			if (recorded.delegated) return recorded.files;
			const component = this.deps.catalog.find((candidate) => candidate.id === componentId);
			if (!component) return null;
			const target = adapterFor(component.kind).targetDir(this.adapterContext(), this.adapterComponent(component));
			if (!target || !existsSync(target)) return null;
			return this.hashedTargetSync(componentId, target);
		};

		const { actions, blocked } = computePlan({ desired, state, diskFiles });

		let finalActions = actions;
		if (options.force) {
			const already = new Set(actions.map((action) => action.componentId));
			for (const component of desired) {
				if (already.has(component.id)) continue;
				finalActions = [
					...finalActions,
					{
						type: "install",
						componentId: component.id,
						kind: component.kind,
						toVersion: component.version,
						source: component.source,
					},
				];
			}
			finalActions.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
		}

		return { actions: finalActions.map((action) => this.toDelegatedIfNeeded(action)), blocked, selection, resolved };
	}

	/**
	 * Builds a mutation preview without consulting the registry or any host.
	 *
	 * A dry-run cannot honestly claim a concrete version without making an
	 * external metadata request. Fresh installs and update checks therefore use
	 * the symbolic target `latest`; an actual mutation resolves and pins that
	 * tag before applying. Reinstalls caused by drift/force use the version and
	 * source already recorded in durable state.
	 */
	async resolveDryRunPlan(
		selection: SelectionResult,
		options: { force?: boolean; update?: boolean } = {},
	): Promise<EnginePlan> {
		const state = loadState(this.deps.root);
		const actions: PlanAction[] = [];

		for (const component of selection.components) {
			assertSafeComponentId(component.id);
			const existing = state.components[component.id];
			if (!existing) {
				actions.push(
					this.toDelegatedIfNeeded({
						type: "install",
						componentId: component.id,
						kind: component.kind as DesiredComponent["kind"],
						toVersion: "latest",
						source: { npmName: component.npmName, resolvedVersion: "latest" },
					}),
				);
				continue;
			}

			if (options.update) {
				actions.push(
					this.toDelegatedIfNeeded({
						type: "update",
						componentId: component.id,
						kind: component.kind as DesiredComponent["kind"],
						fromVersion: existing.version,
						toVersion: "latest",
						source: { npmName: component.npmName, resolvedVersion: "latest" },
					}),
				);
				continue;
			}

			const target = this.targetDirFor(component);
			const onDisk = target && existsSync(target) ? await hashTree(target) : null;
			if (options.force || onDisk === null || !filesEqual(onDisk, existing.files)) {
				actions.push(
					this.toDelegatedIfNeeded({
						type: "install",
						componentId: component.id,
						kind: component.kind as DesiredComponent["kind"],
						toVersion: existing.version,
						source: existing.source,
					}),
				);
			}
		}

		actions.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
		return { actions, blocked: [], selection, resolved: new Map() };
	}

	/** Rewrites file-shaped actions into delegated ones when the kind's adapter does not own files. */
	private toDelegatedIfNeeded(action: PlanAction): PlanAction {
		const adapter = adapterFor(action.kind);
		if (adapter.payload !== "delegated") return action;
		if (action.type === "install" || action.type === "update") {
			return { type: "delegate-install", componentId: action.componentId, kind: action.kind };
		}
		if (action.type === "remove") {
			return { type: "delegate-uninstall", componentId: action.componentId, kind: action.kind };
		}
		return action;
	}

	private hashedTargetCache = new Map<string, Array<{ path: string; sha256: string }>>();

	/**
	 * `computePlan` is synchronous by design, so target hashes are computed
	 * ahead of it and read from this cache. `prepareDiskHashes` fills it.
	 */
	private hashedTargetSync(componentId: string, _target: string): Array<{ path: string; sha256: string }> | null {
		return this.hashedTargetCache.get(componentId) ?? null;
	}

	/** Hashes every installed component's target directory so the synchronous planner can consult them. */
	async prepareDiskHashes(): Promise<void> {
		this.hashedTargetCache.clear();
		const state = loadState(this.deps.root);
		for (const [componentId, recorded] of Object.entries(state.components)) {
			if (recorded.delegated) continue;
			const component = this.deps.catalog.find((candidate) => candidate.id === componentId);
			if (!component) continue;
			const target = adapterFor(component.kind).targetDir(this.adapterContext(), this.adapterComponent(component));
			if (!target || !existsSync(target)) continue;
			this.hashedTargetCache.set(componentId, await hashTree(target));
		}
	}

	/** Refuses to mutate while the install root is in a state a mutation could make worse. */
	assertMutationAllowed(): void {
		// A corrupt state document surfaces here as a typed error rather than
		// being overwritten by the next successful transaction.
		loadState(this.deps.root);

		const assessment = assessCrashedTransactions(this.deps.root, {
			home: this.deps.home,
			installRoot: this.deps.root,
		});
		if (!assessment.recoverable) {
			throw new BlockedError(
				"unrecoverable-transaction",
				`refusing to mutate: a previous transaction did not complete and cannot be recovered automatically (${assessment.blockers.join("; ")}). Run "draht-install doctor" for details.`,
				{ blockers: assessment.blockers },
			);
		}
	}

	/**
	 * Applies a plan as one transaction under the engine's exclusive lock,
	 * recovering any interrupted predecessor first.
	 */
	async apply(
		plan: EnginePlan,
		options: { command: string; onEvent?: (event: ApplyEvent) => void },
	): Promise<ApplyOutcome> {
		const { onEvent } = options;
		const notes: string[] = [];
		this.assertMutationAllowed();

		const lock = acquireLock(this.deps.root, { command: options.command });
		try {
			const recovery = recoverCrashedTransactions(this.deps.root, {
				home: this.deps.home,
				installRoot: this.deps.root,
			});
			if (recovery.transactions.length > 0) {
				notes.push(...recovery.notes);
				onEvent?.({ event: "recovered", transactions: recovery.transactions, notes: recovery.notes });
			}

			if (plan.actions.length === 0) {
				return { applied: [], blocked: plan.blocked, notes, state: loadState(this.deps.root) };
			}

			const state = loadState(this.deps.root);
			const result = await applyPlan({
				root: this.deps.root,
				plan: plan.actions,
				signal: this.deps.signal,

				materialize: async (action, stagingComponentDir): Promise<MaterializedComponent> => {
					onEvent?.({ event: "action-start", componentId: action.componentId, type: action.type });
					const component = this.componentById(action.componentId);
					const adapter = adapterFor(action.kind);
					const target = this.targetDirFor(component);
					if (!target) {
						throw new CliError(
							"internal",
							`component "${component.id}" has no target directory but is not delegated`,
						);
					}
					assertNoSymlinkPivot(target, this.deps.home);

					if (action.type === "remove") {
						// Deregistration happens here — before the payload is backed up
						// or deleted — so a host that still holds a reference blocks the
						// removal instead of being left pointing at deleted files.
						const outcome = await adapter.deregister(
							this.adapterContext(),
							this.adapterComponent(component),
							target,
						);
						if (!outcome.deregistered) {
							throw new CliError(
								"deregistration-incomplete",
								`refusing to delete ${component.id}: its host has not released it (${outcome.notes.join("; ") || "no detail reported"})`,
								{ detail: { component: component.id, notes: outcome.notes } },
							);
						}
						const recorded: ComponentState | undefined = state.components[component.id];
						return {
							targetDir: target,
							files: [],
							version: recorded?.version ?? "0.0.0",
							source: recorded?.source ?? {
								npmName: component.npmName,
								resolvedVersion: recorded?.version ?? "0.0.0",
							},
						};
					}

					const pkg = plan.resolved.get(component.id);
					if (!pkg) throw new CliError("internal", `no resolved package for component "${component.id}"`);
					const payloadDir = await materializeFromCache(this.deps.root, pkg, this.deps.registry);
					assertPayloadIdentity(payloadDir, component.npmName, pkg.version);
					await adapter.stage(
						this.adapterContext(),
						this.adapterComponent(component),
						payloadDir,
						stagingComponentDir,
					);

					const files = await hashTree(stagingComponentDir);
					for (const file of files) assertSafeRelativePath(file.path);

					return {
						targetDir: target,
						files,
						version: pkg.version,
						source: { npmName: component.npmName, resolvedVersion: pkg.version, integrity: pkg.integrity },
					};
				},

				register: async (action, ctx) => {
					if (action.type === "remove") {
						onEvent?.({ event: "action-done", componentId: action.componentId, type: action.type, notes: [] });
						return;
					}
					const component = this.componentById(action.componentId);
					const outcome = await adapterFor(action.kind).register(
						this.adapterContext(),
						this.adapterComponent(component),
						ctx.targetDir,
					);
					onEvent?.({
						event: "action-done",
						componentId: action.componentId,
						type: action.type,
						version: plan.resolved.get(action.componentId)?.version,
						notes: outcome.notes,
					});
					notes.push(...outcome.notes);
					return { registered: outcome.registered, effectiveness: outcome.effectiveness };
				},

				delegate: async (action) => {
					onEvent?.({ event: "action-start", componentId: action.componentId, type: action.type });
					const component = this.componentById(action.componentId);
					const adapter = adapterFor(action.kind);

					if (action.type === "delegate-uninstall") {
						const outcome = await adapter.delegateUninstall?.(
							this.adapterContext(),
							this.adapterComponent(component),
						);
						if (!outcome) throw new CliError("internal", `kind "${action.kind}" cannot delegate an uninstall`);
						onEvent?.({
							event: "action-done",
							componentId: action.componentId,
							type: action.type,
							notes: outcome.notes,
						});
						notes.push(...outcome.notes);
						const recorded = state.components[component.id];
						return {
							version: recorded?.version ?? "0.0.0",
							source: recorded?.source ?? {
								npmName: component.npmName,
								resolvedVersion: recorded?.version ?? "0.0.0",
							},
							delegated: { method: outcome.method, packageName: outcome.packageName },
							effectiveness: outcome.effectiveness,
						};
					}

					const pkg = plan.resolved.get(component.id);
					if (!pkg) throw new CliError("internal", `no resolved package for component "${component.id}"`);
					const outcome = await adapter.delegateInstall?.(
						this.adapterContext(),
						this.adapterComponent(component),
						pkg.version,
					);
					if (!outcome) throw new CliError("internal", `kind "${action.kind}" cannot delegate an install`);
					onEvent?.({
						event: "action-done",
						componentId: action.componentId,
						type: action.type,
						version: pkg.version,
						notes: outcome.notes,
					});
					notes.push(...outcome.notes);
					return {
						version: pkg.version,
						source: { npmName: component.npmName, resolvedVersion: pkg.version, integrity: pkg.integrity },
						delegated: { method: outcome.method, packageName: outcome.packageName },
						effectiveness: outcome.effectiveness,
					};
				},
			});

			return { tx: result.tx, applied: plan.actions, blocked: plan.blocked, notes, state: result.state };
		} catch (error) {
			if (error instanceof ApplyError) {
				// External hosts and package managers are outside the byte-atomic
				// filesystem transaction. If one may have changed, this is a partial
				// outcome even when an abort signal was also observed.
				if (error.unrolledEffects.length > 0) {
					throw new CliError("apply-partial", error.message, {
						exitCode: 3,
						detail: { tx: error.tx, unrolledEffects: error.unrolledEffects },
						cause: error,
					});
				}
				// An operator-requested stop is a blocked command, not a failure:
				// the transaction rolled back and the machine is exactly as it was.
				if (this.deps.signal?.aborted) {
					throw new BlockedError(
						"interrupted",
						`interrupted before the transaction completed; it was rolled back and nothing was changed (${error.message})`,
						{ tx: error.tx, unrolledEffects: error.unrolledEffects },
					);
				}
			}
			throw error;
		} finally {
			lock.release();
		}
	}

	/** Builds explicit `remove`/`delegate-uninstall` actions for components recorded in state. */
	uninstallPlan(componentIds: string[]): EnginePlan {
		const state = loadState(this.deps.root);
		const ids = componentIds.length > 0 ? componentIds : Object.keys(state.components).sort();
		const actions: PlanAction[] = [];

		for (const id of ids) {
			assertSafeComponentId(id);
			const recorded = state.components[id];
			if (!recorded) continue;
			actions.push(
				this.toDelegatedIfNeeded({
					type: "remove",
					componentId: id,
					kind: recorded.kind,
					fromVersion: recorded.version,
				}),
			);
		}

		return {
			actions,
			blocked: [],
			selection: { mode: "explicit", components: [], skipped: [], hostMissing: [] },
			resolved: new Map(),
		};
	}

	/** Reports what is installed and whether the bytes on disk still match what was recorded. */
	async status(): Promise<StatusComponent[]> {
		const state = loadState(this.deps.root);
		const result: StatusComponent[] = [];

		for (const [id, recorded] of Object.entries(state.components).sort(([a], [b]) => (a < b ? -1 : 1))) {
			const component = this.deps.catalog.find((candidate) => candidate.id === id);
			let target: string | null = null;
			// Starts `unknown`: a component only earns a verdict once this build can
			// actually resolve and inspect what backs it.
			let drift: DriftStatus = "unknown";

			if (recorded.delegated) {
				drift = "delegated";
			} else if (component) {
				target = adapterFor(component.kind).targetDir(this.adapterContext(), this.adapterComponent(component));
				if (!target || !existsSync(target)) {
					drift = "missing";
				} else {
					const onDisk = await hashTree(target);
					drift = filesEqual(onDisk, recorded.files) ? "clean" : "drifted";
				}
			}

			result.push({
				id,
				kind: recorded.kind,
				version: recorded.version,
				effectiveness: recorded.effectiveness,
				drift,
				delegated: recorded.delegated,
				targetDir: target,
			});
		}

		return result;
	}

	/** Removes cache entries no recorded component refers to. Used only by explicit commands. */
	pruneCache(): void {
		const cache = `${this.deps.root}/cache`;
		if (existsSync(cache)) rmSync(cache, { recursive: true, force: true });
	}
}

/**
 * Verifies that an extracted payload is the package that was resolved.
 *
 * Integrity verification proves the bytes are the ones the registry published
 * at that URL; it does not prove the URL belonged to the package that was
 * asked for. This closes that gap by checking the payload's own manifest
 * against the resolved name and version. A payload with no manifest is
 * refused rather than trusted — every npm tarball has one.
 */
export function assertPayloadIdentity(payloadDir: string, expectedName: string, expectedVersion: string): void {
	const manifestPath = join(payloadDir, "package.json");
	if (!existsSync(manifestPath)) {
		throw new CliError(
			"source-identity-mismatch",
			`refusing ${expectedName}@${expectedVersion}: the downloaded payload contains no package.json, so its identity cannot be verified`,
			{ detail: { expectedName, expectedVersion } },
		);
	}

	let manifest: { name?: unknown; version?: unknown };
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new CliError(
			"source-identity-mismatch",
			`refusing ${expectedName}@${expectedVersion}: the downloaded payload's package.json is not valid JSON`,
			{ detail: { expectedName, expectedVersion }, cause: error },
		);
	}

	if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
		throw new CliError(
			"source-identity-mismatch",
			`refusing ${expectedName}@${expectedVersion}: the downloaded payload identifies itself as ${String(manifest.name)}@${String(manifest.version)}`,
			{ detail: { expectedName, expectedVersion, actualName: manifest.name, actualVersion: manifest.version } },
		);
	}
}

export function filesEqual(
	left: Array<{ path: string; sha256: string }>,
	right: Array<{ path: string; sha256: string }>,
): boolean {
	if (left.length !== right.length) return false;
	const byPath = new Map(right.map((file) => [file.path, file.sha256]));
	return left.every((file) => byPath.get(file.path) === file.sha256);
}
