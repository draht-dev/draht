import type { ModelSpec, ProviderSnapshot } from "./services.ts";

type Contribution<D> = (draft: D, owner: string) => void;

class ReplayRegistry<D, S> {
	private readonly build: (draft: D) => S;
	private readonly contributions: Array<{ owner: string; run: Contribution<D> }> = [];
	private readonly createDraft: () => D;
	private state: S;

	constructor(createDraft: () => D, build: (draft: D) => S) {
		this.build = build;
		this.createDraft = createDraft;
		this.state = build(createDraft());
	}

	add(owner: string, run: Contribution<D>): void {
		this.contributions.push({ owner, run });
	}

	rebuild(): S {
		const draft = this.createDraft();
		for (const { owner, run } of this.contributions) run(draft, owner);
		this.state = this.build(draft);
		return this.state;
	}

	current(): S {
		return this.state;
	}
}

interface ProviderEntry {
	configured: boolean;
	models: ModelSpec[];
	refreshers: Array<{ id: string; refresh(signal: AbortSignal): Promise<void> }>;
}

class ProviderDraftState {
	readonly entries = new Map<string, ProviderEntry>();

	entry(id: string): ProviderEntry {
		let entry = this.entries.get(id);
		if (!entry) {
			entry = { configured: false, models: [], refreshers: [] };
			this.entries.set(id, entry);
		}
		return entry;
	}
}

export class ProviderDraft {
	private readonly owner: string;
	private readonly state: ProviderDraftState;

	constructor(owner: string, state: ProviderDraftState) {
		this.owner = owner;
		this.state = state;
	}

	native(id: string, models: readonly ModelSpec[]): void {
		this.state.entry(id).models = models.map((model) => ({ ...model, provider: id }));
	}

	models(id: string, transform: (models: readonly ModelSpec[]) => readonly ModelSpec[]): void {
		const entry = this.state.entry(id);
		entry.models = transform(entry.models.map((model) => ({ ...model }))).map((model) => ({
			...model,
			provider: id,
		}));
	}

	configured(id: string): void {
		this.state.entry(id).configured = true;
	}

	refresh(id: string, localId: string, refresh: (signal: AbortSignal) => Promise<void>): void {
		this.state.entry(id).refreshers.push({ id: `${this.owner}:${localId}`, refresh });
	}
}

interface ProviderState {
	availableModels: readonly ModelSpec[];
	models: readonly ModelSpec[];
	refreshers: ReadonlyArray<{ id: string; refresh(signal: AbortSignal): Promise<void> }>;
}

export class ProviderRegistry {
	private readonly listeners = new Set<(snapshot: ProviderSnapshot) => void>();
	private readonly registry = new ReplayRegistry(
		() => new ProviderDraftState(),
		(draft): ProviderState => {
			const models: ModelSpec[] = [];
			const availableModels: ModelSpec[] = [];
			const refreshers: Array<{ id: string; refresh(signal: AbortSignal): Promise<void> }> = [];
			for (const entry of draft.entries.values()) {
				models.push(...entry.models.map((model) => ({ ...model })));
				if (entry.configured) availableModels.push(...entry.models.map((model) => ({ ...model })));
				refreshers.push(...entry.refreshers);
			}
			const byId = (left: ModelSpec, right: ModelSpec) =>
				`${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`);
			return { availableModels: availableModels.sort(byId), models: models.sort(byId), refreshers };
		},
	);
	private revision = 0;
	private serialized = "";

	add(owner: string, contribution: (draft: ProviderDraft) => void): void {
		this.registry.add(owner, (draft) => contribution(new ProviderDraft(owner, draft)));
	}

	rebuild(): void {
		const state = this.registry.rebuild();
		const serialized = JSON.stringify({ availableModels: state.availableModels, models: state.models });
		if (serialized === this.serialized) return;
		this.serialized = serialized;
		this.revision++;
		for (const listener of this.listeners) listener(this.snapshot());
	}

	snapshot(): ProviderSnapshot {
		const state = this.registry.current();
		return {
			revision: this.revision,
			availableModels: state.availableModels.map((model) => ({ ...model })),
			models: state.models.map((model) => ({ ...model })),
		};
	}

	subscribe(listener: (snapshot: ProviderSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	async refresh(signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
		signal.throwIfAborted();
		const errors = new Map<string, string>();
		await Promise.all(
			this.registry.current().refreshers.map(async ({ id, refresh }) => {
				try {
					await refresh(signal);
				} catch (error) {
					if (!signal.aborted) errors.set(id, error instanceof Error ? error.message : String(error));
				}
			}),
		);
		if (!signal.aborted) this.rebuild();
		return errors;
	}
}
