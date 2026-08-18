import type { CommittedWrite } from "./commit.ts";
import type { Entry, ForkOptions } from "./types.ts";
import {
	entryLabel,
	laneConfig,
	laneLastResult,
	laneLeaf,
	laneState,
	type StoredValue,
	sessionName,
	type Value,
	value,
} from "./values.ts";

export interface ForkSourceSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	/** False when a backend supplied only the requested branch rather than the full tree. */
	entriesComplete?: boolean;
}

export interface ForkDestinationSnapshot {
	entries: Map<string, Entry>;
	scalarValues: StoredValue<unknown>[];
	nextSeq: number;
}

function storedValuesInNamespace<T>(values: readonly StoredValue<unknown>[], address: Value<T>): StoredValue<T>[] {
	return values.filter((stored) => stored.address.namespace === address.namespace) as StoredValue<T>[];
}

function findStoredValue<T>(values: readonly StoredValue<unknown>[], address: Value<T>): StoredValue<T> | undefined {
	return values.find(
		(stored) => stored.address.namespace === address.namespace && stored.address.key === address.key,
	) as StoredValue<T> | undefined;
}

/** Build the complete logical state for a forked destination session. */
export function createForkSnapshot(source: ForkSourceSnapshot, options: ForkOptions): ForkDestinationSnapshot {
	const sourceEntries = new Map(source.entries.map((entry) => [entry.id, entry]));
	const sourceLeaves = storedValuesInNamespace(source.scalarValues, laneLeaf(""));
	validateForkSourceSnapshot(source, sourceEntries, sourceLeaves, options);

	const { entryIds, laneToLeafId } = selectForkContents(sourceEntries, sourceLeaves, options);
	const entries = new Map<string, Entry>();
	for (const id of entryIds) entries.set(id, sourceEntries.get(id)!);

	const scalarValues: StoredValue<unknown>[] = [];
	let nextSeq = Math.max(0, ...[...entries.values()].map((entry) => entry.seq)) + 1;
	const store = <T>(address: Value<T>, storedValue: T): void => {
		scalarValues.push({
			address: value<unknown>(address.namespace, address.key),
			value: storedValue,
			seq: nextSeq++,
		});
	};
	for (const [lane, leaf] of laneToLeafId) {
		const configuration = findStoredValue(source.scalarValues, laneConfig(lane));
		if (configuration !== undefined) store(laneConfig(lane), configuration.value);
		store(laneLeaf(lane), leaf);
		store(laneState(lane), { currentOperationId: null, pendingNextRun: [] });
	}
	const name = findStoredValue(source.scalarValues, sessionName);
	if (name !== undefined) store(sessionName, name.value);
	for (const entryId of entryIds) {
		const label = findStoredValue(source.scalarValues, entryLabel(entryId));
		if (label !== undefined) store(entryLabel(entryId), label.value);
	}

	return { entries, scalarValues, nextSeq };
}

export function forkSnapshotWrites(snapshot: ForkDestinationSnapshot): CommittedWrite[] {
	const writes: CommittedWrite[] = [];
	for (const entry of snapshot.entries.values()) writes.push({ kind: "entry", ...entry });
	for (const stored of snapshot.scalarValues) {
		writes.push({
			kind: "value",
			op: "set",
			seq: stored.seq,
			namespace: stored.address.namespace,
			key: stored.address.key,
			value: stored.value,
		});
	}
	return writes.sort((left, right) => left.seq - right.seq);
}

function selectForkContents(
	sourceEntries: Map<string, Entry>,
	sourceLeaves: StoredValue<string | null>[],
	options: ForkOptions,
): { entryIds: Set<string>; laneToLeafId: Map<string, string | null> } {
	const entryIds = new Set<string>();
	const laneToLeafId = new Map<string, string | null>();
	if (options.scope === "tree") {
		for (const id of sourceEntries.keys()) entryIds.add(id);
		for (const stored of sourceLeaves) laneToLeafId.set(stored.address.key, stored.value);
	} else {
		const mainLeaf = sourceLeaves.find((stored) => stored.address.key === "main");
		if (mainLeaf === undefined) throw new Error("Source session is missing main lane");
		const requested = options.entryId ?? mainLeaf.value;
		let leaf = requested;
		if (requested !== null) {
			const target = sourceEntries.get(requested);
			if (target === undefined) throw new Error(`Unknown fork entry: ${requested}`);
			if (options.position === "before") leaf = target.parentId;
		}

		let entryId = leaf;
		while (entryId !== null) {
			const entry = sourceEntries.get(entryId);
			if (entry === undefined) throw new Error(`Corrupt source branch: missing parent ${entryId}`);
			entryIds.add(entryId);
			entryId = entry.parentId;
		}
		laneToLeafId.set("main", leaf);
	}
	return { entryIds, laneToLeafId };
}

function validateForkSourceSnapshot(
	source: ForkSourceSnapshot,
	sourceEntries: Map<string, Entry>,
	sourceLeaves: StoredValue<string | null>[],
	options: ForkOptions,
): void {
	const sourceLeafKeys = new Set(sourceLeaves.map((stored) => stored.address.key));

	if (!sourceLeafKeys.has("main")) throw new Error("Source session is missing main lane");
	for (const stored of source.scalarValues) {
		if (
			(stored.address.namespace === laneConfig("").namespace ||
				stored.address.namespace === laneState("").namespace ||
				stored.address.namespace === laneLastResult("").namespace) &&
			!sourceLeafKeys.has(stored.address.key)
		) {
			throw new Error(`Source session lane ${JSON.stringify(stored.address.key)} is missing lane.leaf`);
		}
	}
	for (const leaf of sourceLeaves) {
		if (findStoredValue(source.scalarValues, laneState(leaf.address.key)) === undefined) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.address.key)} is missing lane.state`);
		}
		if (
			leaf.address.key !== "main" &&
			findStoredValue(source.scalarValues, laneConfig(leaf.address.key)) === undefined
		) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.address.key)} is missing lane.config`);
		}
		if (
			(source.entriesComplete !== false || options.scope === "tree") &&
			leaf.value !== null &&
			!sourceEntries.has(leaf.value)
		) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.address.key)} has an unknown leaf`);
		}
	}
}
