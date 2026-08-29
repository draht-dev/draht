import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import {
	type Context,
	createLoopbackServiceConnection,
	createRemoteServiceBinding,
	defineService,
	getServiceInstanceKey,
	type JsonValue,
	type RemoteServiceConnection,
	RemoteServiceProvider,
	type ReplicatedState,
	replicatedState,
} from "../src/index.ts";

type ModelRef = { provider: string; modelId: string };
type ModelsState = {
	selected: ModelRef | null;
	revision: number;
};
interface Models {
	readonly state: ReplicatedState<ModelsState>;
	select(model: ModelRef, context: Context): Promise<void>;
}

const Models = defineService<Models>("test.models");

type Question = { question: string };
interface QuestionDialogs {
	readonly request: ReplicatedState<Question>;
	submit(answer: string, context: Context): Promise<{ accepted: boolean }>;
}

const QuestionDialogs = defineService<QuestionDialogs>("test.question-dialog");

type EchoPayload = { value: string };
interface Echo {
	echo(payload: EchoPayload, context: Context): Promise<EchoPayload>;
}

const Echo = defineService<Echo>("test.echo");

interface JsonPassthrough {
	call(value: JsonValue, context: Context): Promise<JsonValue>;
}

interface NonJsonArgument {
	call(value: Date, context: Context): Promise<void>;
}

interface NonJsonResult {
	call(context: Context): Promise<bigint>;
}

interface NonJsonState {
	readonly state: ReplicatedState<{ value: undefined }>;
}

describe("remote services", () => {
	test("checks remote JSON contracts only at compile time", () => {
		expect(defineService<JsonPassthrough>("test.json-passthrough").local).toBe(false);
		const defineInvalidContracts = (): void => {
			// @ts-expect-error Remote service arguments must be JSON-compatible.
			defineService<NonJsonArgument>("test.non-json-argument");
			// @ts-expect-error Remote service results must be JSON-compatible.
			defineService<NonJsonResult>("test.non-json-result");
			// @ts-expect-error Replicated state must be JSON-compatible.
			defineService<NonJsonState>("test.non-json-state");
		};
		expect(defineInvalidContracts).not.toThrow();
		expect(defineService<NonJsonArgument>("test.local-non-json", { local: true }).local).toBe(true);
	});

	test("marks services remotable by default and reserves Chord service IDs", () => {
		const local = defineService<{ readonly value: string }>("test.local", { local: true });
		expect(Models.local).toBe(false);
		expect(local.local).toBe(true);
		expect(() => defineService("$chord.internal", { local: true })).toThrow(
			"Service IDs beginning with $chord. are reserved",
		);
		expect(() => new RemoteServiceProvider([local])).toThrow("cannot be published remotely");
	});

	test("does not defensively clone borrowed state values", () => {
		const initial: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initial);
		let delivered: ModelsState | undefined;
		const unsubscribe = state.subscribe((value) => {
			delivered = value;
		});
		expect(state.value).toBe(initial);
		expect(delivered).toBe(initial);

		const next: ModelsState = { selected: { provider: "test", modelId: "one" }, revision: 1 };
		state.set(next, BACKGROUND_CONTEXT);
		expect(state.value).toBe(next);
		expect(delivered).toBe(next);
		unsubscribe();
	});

	test("does not defensively clone method arguments or results", async () => {
		const provider = new RemoteServiceProvider([Echo]);
		let received: EchoPayload | undefined;
		const response: EchoPayload = { value: "response" };
		provider.provide(Echo, {
			async echo(payload) {
				received = payload;
				return response;
			},
		});
		const namespace = createRemoteServiceBinding({
			services: [Echo],
			connection: createLoopbackServiceConnection(provider),
		});
		const echo = namespace.use(Echo);
		await namespace.ready(BACKGROUND_CONTEXT);
		const request: EchoPayload = { value: "request" };

		await expect(echo.echo(request, BACKGROUND_CONTEXT)).resolves.toBe(response);
		expect(received).toBe(request);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("provides and consumes one singleton with replicated state", async () => {
		const provider = new RemoteServiceProvider([Models]);
		expect(provider.catalogue).toEqual([{ serviceId: Models.id, mode: "singleton" }]);
		const initialState: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initialState);
		let publishedState: ModelsState | undefined;
		provider.provide(Models, {
			state,
			async select(model, context) {
				publishedState = { selected: model, revision: state.value.revision + 1 };
				state.set(publishedState, context);
			},
		});
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			connection: createLoopbackServiceConnection(provider),
			onError: (error) => errors.push(error),
		});

		const first = namespace.use(Models);
		const second = namespace.use(Models);
		expect(first).toBe(second);
		expect(first.state.value).toBeUndefined();
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(first.state.value).toBe(initialState);

		const updates: ModelsState[] = [];
		const unsubscribe = second.state.subscribe((value) => updates.push(value));
		await first.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT);
		expect(first.state.value).toBe(publishedState);
		expect(first.state.value).toEqual({
			selected: { provider: "test", modelId: "one" },
			revision: 1,
		});
		expect(updates).toEqual([
			{ selected: null, revision: 0 },
			{ selected: { provider: "test", modelId: "one" }, revision: 1 },
		]);
		expect(errors).toEqual([]);

		const lateNamespace = createRemoteServiceBinding({
			services: [Models],
			connection: createLoopbackServiceConnection(provider),
		});
		const lateModels = lateNamespace.use(Models);
		await lateNamespace.ready(BACKGROUND_CONTEXT);
		expect(lateModels.state.value?.revision).toBe(1);

		unsubscribe();
		await Promise.all([namespace.dispose(BACKGROUND_CONTEXT), lateNamespace.dispose(BACKGROUND_CONTEXT)]);
		provider.dispose();
	});

	test("keeps singleton facades stable when their provider is replaced", async () => {
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 1 }),
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			connection: createLoopbackServiceConnection(provider),
		});
		const models = namespace.use(Models);
		const state = models.state;
		const select = models.select;
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(state.value?.revision).toBe(1);

		provider.withdraw(Models);
		expect(state.value).toBeUndefined();
		await expect(select({ provider: "test", modelId: "unavailable" }, BACKGROUND_CONTEXT)).rejects.toMatchObject({
			code: "service_not_found",
		});

		const replacementSelect = vi.fn(async () => {});
		provider.replace(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 2 }),
			select: replacementSelect,
		});

		expect(namespace.use(Models)).toBe(models);
		expect(models.state).toBe(state);
		expect(state.value?.revision).toBe(2);
		await select({ provider: "test", modelId: "replacement" }, BACKGROUND_CONTEXT);
		expect(replacementSelect).toHaveBeenCalledOnce();

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("keeps deferred service handles inaccessible until host activation", async () => {
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 0 }),
			async select() {},
		});
		let active = false;
		const namespace = createRemoteServiceBinding({
			services: [Models],
			connection: createLoopbackServiceConnection(provider),
			bound: false,
			assertAccess() {
				if (!active) throw new Error("Service handles are not active");
			},
		});
		const models = namespace.use(Models);

		expect(() => models.state.value).toThrow("Service handles are not active");
		expect(() => models.state.subscribe(() => {})).toThrow("Service handles are not active");
		expect(() => models.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT)).toThrow(
			"Service handles are not active",
		);

		await namespace.rebind(true, BACKGROUND_CONTEXT);
		active = true;
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(0);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("rejects namespace readiness when initial hydration fails", async () => {
		const failure = new Error("initial hydration failed");
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			connection: {
				invoke: () => Promise.reject(new Error("unexpected invocation")),
				subscribe: () => Promise.reject(failure),
			},
			onError: (error) => errors.push(error),
		});
		const models = namespace.use(Models);

		await expect(namespace.ready(BACKGROUND_CONTEXT)).rejects.toBe(failure);
		expect(models.state.value).toBeUndefined();
		expect(errors).toEqual([failure]);
		await namespace.dispose(BACKGROUND_CONTEXT);
	});

	test("buffers state updates that race subscription hydration", async () => {
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, {
			state,
			async select() {},
		});
		const connection: RemoteServiceConnection = {
			invoke: (call, context) => provider.invoke(call, context),
			subscribe: async (serviceId, mode, listener) => {
				const subscription = provider.subscribe(serviceId, mode, listener);
				state.set({ selected: null, revision: 1 }, BACKGROUND_CONTEXT);
				return {
					snapshot: subscription.snapshot,
					activate: () => subscription.activate(),
					close: () => subscription.close(),
				};
			},
		};
		const namespace = createRemoteServiceBinding({ services: [Models], connection });
		const models = namespace.use(Models);
		const revisions: number[] = [];
		models.state.subscribe((value) => revisions.push(value.revision));

		await vi.waitFor(() => expect(revisions).toEqual([0, 1]));
		expect(models.state.value?.revision).toBe(1);
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("hydrates cold ReplicatedState replicas and replaces them across rebinds", async () => {
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, {
			state,
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			connection: createLoopbackServiceConnection(provider),
			bound: false,
		});
		const models = namespace.use(Models);
		const revisions: number[] = [];
		models.state.subscribe((value) => revisions.push(value.revision));
		expect(models.state.value).toBeUndefined();
		expect(revisions).toEqual([]);

		state.set({ selected: null, revision: 1 }, BACKGROUND_CONTEXT);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(1);
		expect(revisions).toEqual([1]);
		state.set({ selected: null, revision: 2 }, BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);

		await namespace.rebind(false, BACKGROUND_CONTEXT);
		expect(models.state.value).toBeUndefined();
		state.set({ selected: null, revision: 3 }, BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(3);
		expect(revisions).toEqual([1, 2, 3]);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("hydrates keyed state before observe handlers and fences reused keys", async () => {
		const provider = new RemoteServiceProvider([{ service: QuestionDialogs, mode: "keyed" }]);
		expect(provider.catalogue).toEqual([{ serviceId: QuestionDialogs.id, mode: "keyed" }]);
		const connection = createLoopbackServiceConnection(provider);
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [QuestionDialogs],
			connection,
			onError: (error) => errors.push(error),
		});
		const observed: {
			key: string;
			question: Question | undefined;
			service: QuestionDialogs;
			context: Context;
		}[] = [];
		const stop = namespace.observe(QuestionDialogs, (service, context) => {
			observed.push({
				key: getServiceInstanceKey(service)!,
				question: service.request.value,
				service,
				context,
			});
		});
		await vi.waitFor(() => expect(errors).toEqual([]));

		const firstRequest = replicatedState<Question>({ question: "First?" });
		const firstSubmit = vi.fn(async () => ({ accepted: true }));
		const closeFirst = provider.spawn(QuestionDialogs, "invocation-1", {
			request: firstRequest,
			submit: firstSubmit,
		});
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		expect(observed[0]).toMatchObject({ key: "invocation-1", question: { question: "First?" } });

		const firstService = observed[0]!.service;
		firstRequest.set({ question: "Updated?" }, BACKGROUND_CONTEXT);
		expect(firstService.request.value).toEqual({ question: "Updated?" });
		await expect(firstService.submit("yes", BACKGROUND_CONTEXT)).resolves.toEqual({ accepted: true });
		expect(firstSubmit).toHaveBeenCalledWith("yes", expect.objectContaining({ abortSignal: undefined }));

		closeFirst();
		expect(observed[0]!.context.abortSignal?.aborted).toBe(true);
		await expect(firstService.submit("late", BACKGROUND_CONTEXT)).rejects.toMatchObject({
			code: "service_stale_instance",
		});

		const secondRequest = replicatedState<Question>({ question: "Again?" });
		const closeSecond = provider.spawn(QuestionDialogs, "invocation-1", {
			request: secondRequest,
			async submit() {
				return { accepted: false };
			},
		});
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(observed[1]).toMatchObject({ key: "invocation-1", question: { question: "Again?" } });
		expect(observed[1]!.service).not.toBe(firstService);
		expect(errors).toEqual([]);

		closeSecond();
		stop();
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("rejects mode mixing and unsupported members", () => {
		const provider = new RemoteServiceProvider([Models, { service: QuestionDialogs, mode: "keyed" }]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 0 }),
			async select() {},
		});
		expect(() => provider.spawn(Models, "wrong", {} as Models)).toThrow(/singleton/);
		expect(() =>
			provider.spawn(QuestionDialogs, "invalid", {
				request: new Date() as unknown as ReplicatedState<Question>,
				async submit() {
					return { accepted: true };
				},
			}),
		).toThrow(/not remotely exposable/);
		provider.dispose();
	});
});
