import {
	BACKGROUND_CONTEXT,
	type Context,
	defineService,
	type MutableReplicatedState,
	type ReplicatedState,
} from "@draht/agent-core";
import { describe, expect, test, vi } from "vitest";
import { bindService, createFacetHost, defineFacet } from "../src/experimental/facets.ts";

interface Source {
	read(context: Context): Promise<string>;
}

interface Projection {
	read(context: Context): Promise<string>;
}

interface KeyedValue {
	read(context: Context): Promise<string>;
}

interface Watched {
	readonly state: ReplicatedState<{ value: number }>;
}

interface HostValues {
	readonly name: string;
	readonly use: string;
}

const Source = defineService<Source>("test.experimental.source");
const Projection = defineService<Projection>("test.experimental.projection");
const KeyedValue = defineService<KeyedValue>("test.experimental.keyed-value");
const Watched = defineService<Watched>("test.experimental.watched");
const HostValues = defineService<HostValues>("test.experimental.host-values");

describe("experimental facet host", () => {
	test("discovers setup dependencies before connecting stable service handles", async () => {
		const trace: string[] = [];
		let sourceHandle: Source | undefined;
		const projection = defineFacet({
			id: "projection",
			setup(env) {
				trace.push("setup projection");
				sourceHandle = env.use(Source);
				expect(() => sourceHandle!.read(BACKGROUND_CONTEXT)).toThrow(
					"Facet service handles cannot be used during setup",
				);
				env.provide(Projection, {
					read: (context) => sourceHandle!.read(context),
				});
				env.onActivate(() => {
					trace.push("activate projection");
				});
				env.onDeactivate(() => {
					trace.push("dispose projection");
				});
			},
		});
		const source = defineFacet({
			id: "source",
			setup(env) {
				trace.push("setup source");
				env.provide(Source, {
					async read() {
						return "value";
					},
				});
				env.onActivate(() => {
					trace.push("activate source");
				});
				env.onDeactivate(() => {
					trace.push("dispose source");
				});
			},
		});
		const host = await createFacetHost({ facets: [projection, source] });

		expect(trace).toEqual(["setup projection", "setup source", "activate source", "activate projection"]);
		expect(await sourceHandle!.read(BACKGROUND_CONTEXT)).toBe("value");
		expect(await host.services.use(Projection).read(BACKGROUND_CONTEXT)).toBe("value");

		await host.dispose();
		expect(trace.slice(-2)).toEqual(["dispose projection", "dispose source"]);
	});

	test("connects keyed observations only when the observing facet activates", async () => {
		const trace: string[] = [];
		const observer = defineFacet({
			id: "observer",
			setup(env) {
				env.observe(KeyedValue, async (instance, context) => {
					trace.push(`observe ${await instance.service.read(context)}`);
				});
				env.onActivate(() => {
					trace.push("activate observer");
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				const values = env.provideMany(KeyedValue);
				env.onActivate(() => {
					trace.push("activate provider");
					values.add("one", {
						async read() {
							return "one";
						},
					});
				});
			},
		});
		const host = await createFacetHost({ facets: [observer, provider] });
		await vi.waitFor(() => expect(trace).toContain("observe one"));

		expect(trace).toEqual(["activate provider", "activate observer", "observe one"]);
		await host.dispose();
	});

	test("owns resources registered during activation", async () => {
		let state: MutableReplicatedState<{ value: number }> | undefined;
		let deliveries = 0;
		const consumer = defineFacet({
			id: "consumer",
			setup(env) {
				const watched = env.use(Watched);
				env.onActivate(() => {
					env.own(
						watched.state.subscribe(() => {
							deliveries += 1;
						}),
					);
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				state = env.remoteState({ value: 0 });
				env.provide(Watched, { state });
			},
		});
		const host = await createFacetHost({ facets: [consumer, provider] });
		expect(deliveries).toBe(1);
		state!.set({ value: 1 }, BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);

		await host.dispose();
		state!.set({ value: 2 }, BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);
	});

	test("resolves explicit host service bindings", async () => {
		const values: HostValues = { name: "session", use: "host value" };
		const facet = defineFacet({
			id: "host-service-consumer",
			setup(env) {
				const hostValues = env.use(HostValues);
				expect(() => hostValues.use).toThrow("Facet service handles cannot be used during setup");
				env.onActivate(() => {
					expect(hostValues).not.toBe(values);
					expect(hostValues.name).toBe("session");
					expect(hostValues.use).toBe("host value");
				});
			},
		});
		const host = await createFacetHost({ facets: [facet], bindings: [bindService(HostValues, values)] });
		await host.dispose();
	});

	test("rejects missing dependencies, cycles, and asynchronous setup", async () => {
		let activated = false;
		const missing = defineFacet({
			id: "missing",
			setup(env) {
				env.use(Source);
				env.onActivate(() => {
					activated = true;
				});
			},
		});
		await expect(createFacetHost({ facets: [missing] })).rejects.toThrow(
			"Facet missing requires local/test.experimental.source/singleton, but no facet provides it",
		);
		expect(activated).toBe(false);

		const first = defineFacet({
			id: "first",
			setup(env) {
				env.use(Projection);
				env.provide(Source, {
					async read() {
						return "first";
					},
				});
			},
		});
		const second = defineFacet({
			id: "second",
			setup(env) {
				env.use(Source);
				env.provide(Projection, {
					async read() {
						return "second";
					},
				});
			},
		});
		await expect(createFacetHost({ facets: [first, second] })).rejects.toThrow(
			"Facet dependency cycle: first, second",
		);

		const asynchronous = defineFacet({
			id: "asynchronous",
			async setup() {
				await Promise.resolve();
			},
		});
		await expect(createFacetHost({ facets: [asynchronous] })).rejects.toThrow(
			"Facet asynchronous setup must be synchronous",
		);
	});
});
