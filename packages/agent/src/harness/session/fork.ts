import type { CommittedWrite } from "./commit.ts";
import type { Entry, ForkOptions } from "./types.ts";
import {
	branchTip,
	entryLabel,
	laneConfig,
	laneLastResult,
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
	const sourceTips = storedValuesInNamespace(source.scalarValues, branchTip(""));
	validateForkSourceSnapshot(source, sourceEntries, sourceTips, options);

	const { entryIds, sourceToDestinationTip } = selectForkContents(sourceEntries, sourceTips, options);
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
	for (const [sourceName, destination] of sourceToDestinationTip) {
		const configuration = findStoredValue(source.scalarValues, laneConfig(sourceName));
		store(branchTip(destination.name), destination.tipId);
		if (configuration !== undefined) {
			store(laneConfig(destination.name), configuration.value);
			store(laneState(destination.name), {
				currentOperationId: null,
				pendingNextRun: [],
			});
		}
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
	sourceTips: StoredValue<string | null>[],
	options: ForkOptions,
): {
	entryIds: Set<string>;
	sourceToDestinationTip: Map<string, { name: string; tipId: string | null }>;
} {
	const entryIds = new Set<string>();
	const sourceToDestinationTip = new Map<string, { name: string; tipId: string | null }>();
	if (options.scope === "tree") {
		for (const id of sourceEntries.keys()) entryIds.add(id);
		for (const stored of sourceTips) {
			sourceToDestinationTip.set(stored.address.key, {
				name: stored.address.key,
				tipId: stored.value,
			});
		}
	} else {
		const mainTip = sourceTips.find((stored) => stored.address.key === "main");
		if (mainTip === undefined) throw new Error("Source session is missing main branch");
		const requested = options.entryId ?? mainTip.value;
		let tipId = requested;
		if (requested !== null) {
			const target = sourceEntries.get(requested);
			if (target === undefined) throw new Error(`Unknown fork entry: ${requested}`);
			if (options.position === "before") tipId = target.parentId;
		}

		let entryId = tipId;
		while (entryId !== null) {
			const entry = sourceEntries.get(entryId);
			if (entry === undefined) throw new Error(`Corrupt source branch: missing parent ${entryId}`);
			entryIds.add(entryId);
			entryId = entry.parentId;
		}
		sourceToDestinationTip.set("main", { name: "main", tipId });
	}
	return { entryIds, sourceToDestinationTip };
}

function validateForkSourceSnapshot(
	source: ForkSourceSnapshot,
	sourceEntries: Map<string, Entry>,
	sourceTips: StoredValue<string | null>[],
	options: ForkOptions,
): void {
	const sourceTipKeys = new Set(sourceTips.map((stored) => stored.address.key));

	if (options.scope !== "tree" && !sourceTipKeys.has("main")) {
		throw new Error("Source session is missing main branch");
	}
	for (const stored of source.scalarValues) {
		if (
			(stored.address.namespace === laneConfig("").namespace ||
				stored.address.namespace === laneState("").namespace ||
				stored.address.namespace === laneLastResult("").namespace) &&
			!sourceTipKeys.has(stored.address.key)
		) {
			throw new Error(`Source session branch ${JSON.stringify(stored.address.key)} is missing branch.tip`);
		}
	}
	for (const tip of sourceTips) {
		const configuration = findStoredValue(source.scalarValues, laneConfig(tip.address.key));
		const state = findStoredValue(source.scalarValues, laneState(tip.address.key));
		const lastResult = findStoredValue(source.scalarValues, laneLastResult(tip.address.key));
		if ((configuration === undefined) !== (state === undefined)) {
			throw new Error(`Source session branch ${JSON.stringify(tip.address.key)} has incomplete lane state`);
		}
		if (configuration === undefined && lastResult !== undefined) {
			throw new Error(`Source session branch ${JSON.stringify(tip.address.key)} has a result without lane state`);
		}
		if (
			(source.entriesComplete !== false || options.scope === "tree") &&
			tip.value !== null &&
			!sourceEntries.has(tip.value)
		) {
			throw new Error(`Source session branch ${JSON.stringify(tip.address.key)} has an unknown tip`);
		}
	}
}
