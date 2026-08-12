import { compare } from "semver";
import type { ComponentKind, ComponentSource, InstallState, PlanAction } from "./types.ts";

/** A component the caller wants installed, independent of what (if anything) `state` says is currently installed. */
export interface DesiredComponent {
	id: string;
	kind: ComponentKind;
	version: string;
	source: ComponentSource;
}

/** A desired component whose install was skipped because it would silently downgrade an already-installed component. */
export interface BlockedEntry {
	componentId: string;
	reason: "downgrade";
	from: string;
	to: string;
}

export interface ComputePlanInput {
	desired: DesiredComponent[];
	state: InstallState;
	/** Current on-disk `{path, sha256}` pairs for a component's target directory, or `null` if the target is absent. */
	diskFiles: (componentId: string) => Array<{ path: string; sha256: string }> | null;
	/** When true, components present in `state` but absent from `desired` produce `remove` actions. Defaults to `false`. */
	prune?: boolean;
}

export interface ComputePlanResult {
	actions: PlanAction[];
	blocked: BlockedEntry[];
}

function filesMatch(
	onDisk: Array<{ path: string; sha256: string }>,
	recorded: Array<{ path: string; sha256: string }>,
): boolean {
	if (onDisk.length !== recorded.length) return false;
	const recordedByPath = new Map(recorded.map((file) => [file.path, file.sha256]));
	return onDisk.every((file) => recordedByPath.get(file.path) === file.sha256);
}

/**
 * Pure diff between what's desired and what `state` (plus the actual disk
 * contents `diskFiles` reports) says is installed. No filesystem access, no
 * clock reads — every input is passed in, every output is derived from it,
 * so the same input always produces a deep-equal output, and neither
 * `desired` nor `state` is ever mutated.
 *
 * - Absent from `state`, or present but drifted/missing on disk at the same
 *   version → `install`.
 * - Present at a lower version than desired → `update`.
 * - Present at the same version with matching on-disk hashes → no action
 *   (idempotent).
 * - Present at a *higher* version than desired → blocked as a downgrade,
 *   never a silent action.
 * - Present in `state` but absent from `desired` → `remove`, only when
 *   `prune` is true.
 *
 * Ordering is deterministic: installs/updates sorted by `componentId`,
 * removes last (also sorted by `componentId`).
 */
export function computePlan(input: ComputePlanInput): ComputePlanResult {
	const { desired, state, diskFiles, prune = false } = input;

	const actions: PlanAction[] = [];
	const blocked: BlockedEntry[] = [];
	const desiredIds = new Set(desired.map((component) => component.id));
	const sortedDesired = [...desired].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	for (const component of sortedDesired) {
		const existing = state.components[component.id];

		if (!existing) {
			actions.push({
				type: "install",
				componentId: component.id,
				kind: component.kind,
				toVersion: component.version,
				source: component.source,
			});
			continue;
		}

		const cmp = compare(component.version, existing.version);

		if (cmp < 0) {
			blocked.push({
				componentId: component.id,
				reason: "downgrade",
				from: existing.version,
				to: component.version,
			});
			continue;
		}

		if (cmp > 0) {
			actions.push({
				type: "update",
				componentId: component.id,
				kind: component.kind,
				toVersion: component.version,
				fromVersion: existing.version,
				source: component.source,
			});
			continue;
		}

		// Same version: idempotent unless the on-disk payload has drifted or vanished.
		const onDisk = diskFiles(component.id);
		if (onDisk === null || !filesMatch(onDisk, existing.files)) {
			actions.push({
				type: "install",
				componentId: component.id,
				kind: component.kind,
				toVersion: component.version,
				source: component.source,
			});
		}
	}

	if (prune) {
		const removeIds = Object.keys(state.components)
			.filter((id) => !desiredIds.has(id))
			.sort();
		for (const componentId of removeIds) {
			const existing = state.components[componentId];
			actions.push({
				type: "remove",
				componentId,
				kind: existing.kind,
				fromVersion: existing.version,
			});
		}
	}

	return { actions, blocked };
}
