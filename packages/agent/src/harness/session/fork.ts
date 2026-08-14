import type { Usage } from "@draht/ai";
import type { StorageStateSnapshot } from "./storage-state.ts";
import type { Entry, ForkOptions, Register, RegisterNamespace } from "./types.ts";

export interface ForkSourceSnapshot {
	entries: Entry[];
	registers: Register[];
}

function isRegisterNamespace<TNamespace extends RegisterNamespace>(
	register: Register,
	namespace: TNamespace,
): register is Register<TNamespace> {
	return register.namespace === namespace;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Build the complete logical state for a forked destination session. */
export function createForkSnapshot(source: ForkSourceSnapshot, options: ForkOptions): StorageStateSnapshot {
	const sourceEntries = new Map(source.entries.map((entry) => [entry.id, entry]));
	const sourceLeaves = source.registers.filter((register) => isRegisterNamespace(register, "lane.leaf"));
	validateForkSourceSnapshot(source, sourceEntries, sourceLeaves);

	const { entryIds, laneToLeafId } = selectForkContents(sourceEntries, sourceLeaves, options);
	const entries = new Map<string, Entry>();
	for (const id of entryIds) entries.set(id, sourceEntries.get(id)!);

	const registers: Register[] = [];
	let nextSeq = Math.max(0, ...[...entries.values()].map((entry) => entry.seq)) + 1;
	const setRegister = (namespace: RegisterNamespace, key: string, value: Register["value"]): void => {
		registers.push({ namespace, key, value, seq: nextSeq++ } as Register);
	};
	for (const [lane, leaf] of laneToLeafId) {
		const configuration = source.registers.find(
			(register) => register.namespace === "lane.config" && register.key === lane,
		);
		if (configuration !== undefined) setRegister("lane.config", lane, configuration.value);
		setRegister("lane.leaf", lane, leaf);
		setRegister("lane.state", lane, { currentOperationId: null, pendingNextRun: [] });
	}
	for (const register of source.registers) {
		if (
			register.namespace === "fact.name" ||
			register.namespace === "fact.custom" ||
			(register.namespace === "fact.label" && entryIds.has(register.key))
		) {
			setRegister(register.namespace, register.key, register.value);
		}
	}

	return {
		entries,
		registers,
		usage: new Map(),
		stats: {
			messageCount: [...entries.values()].filter((entry) => entry.type === "message").length,
			usage: emptyUsage(),
		},
		nextSeq,
	};
}

function selectForkContents(
	sourceEntries: Map<string, Entry>,
	sourceLeaves: Register<"lane.leaf">[],
	options: ForkOptions,
): { entryIds: Set<string>; laneToLeafId: Map<string, string | null> } {
	const entryIds = new Set<string>();
	const laneToLeafId = new Map<string, string | null>();
	if (options.scope === "tree") {
		for (const id of sourceEntries.keys()) entryIds.add(id);
		for (const register of sourceLeaves) laneToLeafId.set(register.key, register.value);
	} else {
		const mainLeaf = sourceLeaves.find((register) => register.key === "main");
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
	sourceLeaves: Register<"lane.leaf">[],
): void {
	const sourceLeafKeys = new Set(sourceLeaves.map((register) => register.key));

	// TODO: do all these validations need to happen here? maybe somewhere else when the source session is loaded?
	if (!sourceLeafKeys.has("main")) throw new Error("Source session is missing main lane");
	for (const register of source.registers) {
		if (
			(register.namespace === "lane.config" ||
				register.namespace === "lane.state" ||
				register.namespace === "lane.lastResult") &&
			!sourceLeafKeys.has(register.key)
		) {
			throw new Error(`Source session lane ${JSON.stringify(register.key)} is missing lane.leaf`);
		}
	}
	for (const leaf of sourceLeaves) {
		if (!hasRegister(source.registers, "lane.state", leaf.key)) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.key)} is missing lane.state`);
		}
		if (leaf.key !== "main" && !hasRegister(source.registers, "lane.config", leaf.key)) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.key)} is missing lane.config`);
		}
		if (leaf.value !== null && !sourceEntries.has(leaf.value)) {
			throw new Error(`Source session lane ${JSON.stringify(leaf.key)} has an unknown leaf`);
		}
	}
}

function hasRegister(registers: Register[], namespace: RegisterNamespace, key: string): boolean {
	return registers.some((register) => register.namespace === namespace && register.key === key);
}
