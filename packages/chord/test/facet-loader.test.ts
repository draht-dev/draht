import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import {
	type Context,
	combineFacetLoaders,
	createFacetHost,
	createRemoteServiceBinding,
	createStaticFacetLoader,
	defineFacet,
	defineService,
	type FacetLoader,
} from "../src/index.ts";
import { createLoopbackServiceTransport } from "./helpers.ts";

interface GenerationValue {
	read(context: Context): Promise<string>;
}

const LocalGenerationValue = defineService<GenerationValue>("test.experimental.local-generation-value", {
	local: true,
});
const RemoteGenerationValue = defineService<GenerationValue>("test.experimental.remote-generation-value");

const firstFacet = defineFacet({ id: "first", setup() {} });
const secondFacet = defineFacet({ id: "second", setup() {} });

describe("facet loader", () => {
	test("combines loaded facets in loader order and disposes generations in reverse", async () => {
		const trace: string[] = [];
		const first: FacetLoader = {
			async load() {
				trace.push("load first");
				return {
					facets: [firstFacet],
					async dispose() {
						trace.push("dispose first");
					},
				};
			},
		};
		const second: FacetLoader = {
			async load() {
				trace.push("load second");
				return {
					facets: [secondFacet],
					async dispose() {
						trace.push("dispose second");
					},
				};
			},
		};

		const loaded = await combineFacetLoaders([first, second]).load();
		expect(loaded.facets).toEqual([firstFacet, secondFacet]);
		await loaded.dispose();
		await loaded.dispose();
		expect(trace).toEqual(["load first", "load second", "dispose second", "dispose first"]);
	});

	test("cleans up loaded facets when a later loader fails", async () => {
		const dispose = vi.fn(async () => {});
		const failure = new Error("load failed");
		const first: FacetLoader = {
			async load() {
				return { facets: [firstFacet], dispose };
			},
		};
		const second: FacetLoader = {
			async load() {
				throw failure;
			},
		};

		await expect(combineFacetLoaders([first, second]).load()).rejects.toBe(failure);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("keeps local and RPC service handles stable when their provider facet reloads", async () => {
		const trace: string[] = [];
		let localValue: GenerationValue | undefined;
		let generation = 0;
		let reportReplacementStarted!: () => void;
		const replacementStarted = new Promise<void>((resolve) => {
			reportReplacementStarted = resolve;
		});
		let continueReplacement!: () => void;
		const replacementCanContinue = new Promise<void>((resolve) => {
			continueReplacement = resolve;
		});
		const consumer = defineFacet({
			id: "consumer",
			setup(env) {
				trace.push("setup consumer");
				localValue = env.use(LocalGenerationValue);
				env.onActivate(async () => {
					trace.push(`activate consumer:${await localValue!.read(BACKGROUND_CONTEXT)}`);
				});
				env.onDeactivate(() => {
					trace.push("deactivate consumer");
				});
			},
		});
		const loader: FacetLoader = {
			async load() {
				const name = generation++ === 0 ? "A" : "B";
				trace.push(`load ${name}`);
				return {
					facets: [
						defineFacet({
							id: "provider",
							setup(env) {
								trace.push(`setup provider ${name}`);
								const implementation: GenerationValue = {
									async read() {
										return name;
									},
								};
								env.provide(LocalGenerationValue, implementation);
								env.provide(RemoteGenerationValue, implementation);
								env.onActivate(async () => {
									trace.push(`activate provider ${name}`);
									if (name === "B") {
										reportReplacementStarted();
										await replacementCanContinue;
									}
								});
								env.onDeactivate(() => {
									trace.push(`deactivate provider ${name}`);
								});
							},
						}),
					],
					async dispose() {
						trace.push(`unload ${name}`);
					},
				};
			},
		};

		const loadedA = await loader.load();
		const host = await createFacetHost({ facets: [consumer, ...loadedA.facets] });
		const originalLocalHandle = localValue!;
		const localRead = originalLocalHandle.read;
		const remoteServices = createRemoteServiceBinding({
			services: [RemoteGenerationValue],
			transport: createLoopbackServiceTransport(host.services),
		});
		const originalRemoteHandle = remoteServices.use(RemoteGenerationValue);
		const remoteRead = originalRemoteHandle.read;
		await remoteServices.ready(BACKGROUND_CONTEXT);
		await expect(localRead(BACKGROUND_CONTEXT)).resolves.toBe("A");
		await expect(remoteRead(BACKGROUND_CONTEXT)).resolves.toBe("A");

		await expect(
			host.reload([
				defineFacet({
					id: "provider",
					setup(env) {
						env.provide(LocalGenerationValue, {
							async read() {
								return "invalid";
							},
						});
					},
				}),
			]),
		).rejects.toThrow("Reloaded facet provider must preserve its service requirements and provisions");
		await expect(localRead(BACKGROUND_CONTEXT)).resolves.toBe("A");
		await expect(remoteRead(BACKGROUND_CONTEXT)).resolves.toBe("A");

		const loadedB = await loader.load();
		const reload = host.reload(loadedB.facets);
		await replacementStarted;
		expect(() => localRead(BACKGROUND_CONTEXT)).toThrow(`Service ${LocalGenerationValue.id} is disconnected`);
		await expect(remoteRead(BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "service_not_found" });
		continueReplacement();
		await reload;
		await loadedA.dispose();

		expect(localValue).toBe(originalLocalHandle);
		expect(remoteServices.use(RemoteGenerationValue)).toBe(originalRemoteHandle);
		await expect(localRead(BACKGROUND_CONTEXT)).resolves.toBe("B");
		await expect(remoteRead(BACKGROUND_CONTEXT)).resolves.toBe("B");

		await remoteServices.dispose(BACKGROUND_CONTEXT);
		await host.dispose();
		await loadedB.dispose();
		expect(trace).toEqual([
			"load A",
			"setup consumer",
			"setup provider A",
			"activate provider A",
			"activate consumer:A",
			"load B",
			"setup provider B",
			"deactivate provider A",
			"activate provider B",
			"unload A",
			"deactivate consumer",
			"deactivate provider B",
			"unload B",
		]);
	});

	test("rejects remote singleton member shape changes before reload cutover", async () => {
		let retained: GenerationValue | undefined;
		let providerDisposed = false;
		const consumer = defineFacet({
			id: "shape-consumer",
			setup(env) {
				retained = env.use(RemoteGenerationValue);
			},
		});
		const provider = defineFacet({
			id: "shape-provider",
			setup(env) {
				env.provide(RemoteGenerationValue, {
					async read() {
						return "A";
					},
				});
				env.onDeactivate(() => {
					providerDisposed = true;
				});
			},
		});
		const host = await createFacetHost({ facets: [consumer, provider] });

		await expect(
			host.reload([
				defineFacet({
					id: "shape-provider",
					setup(env) {
						env.provide(RemoteGenerationValue, {
							async renamed() {
								return "B";
							},
						} as unknown as GenerationValue);
					},
				}),
			]),
		).rejects.toThrow("replacement must preserve its member shape");
		expect(providerDisposed).toBe(false);
		await expect(retained!.read(BACKGROUND_CONTEXT)).resolves.toBe("A");

		await host.dispose();
		expect(providerDisposed).toBe(true);
	});

	test("terminates the host when replacement activation fails after cutover", async () => {
		const failure = new Error("replacement activation failed");
		const trace: string[] = [];
		let retained: GenerationValue | undefined;
		const consumer = defineFacet({
			id: "terminal-consumer",
			setup(env) {
				retained = env.use(RemoteGenerationValue);
				env.onDeactivate(() => {
					trace.push("deactivate consumer");
				});
			},
		});
		const provider = (name: string, fail: boolean) =>
			defineFacet({
				id: "terminal-provider",
				setup(env) {
					env.provide(RemoteGenerationValue, {
						async read() {
							return name;
						},
					});
					env.onActivate(() => {
						trace.push(`activate ${name}`);
						if (fail) throw failure;
					});
					env.onDeactivate(() => {
						trace.push(`deactivate ${name}`);
					});
				},
			});
		const host = await createFacetHost({ facets: [consumer, provider("A", false)] });
		await expect(retained!.read(BACKGROUND_CONTEXT)).resolves.toBe("A");

		await expect(host.reload([provider("B", true)])).rejects.toBe(failure);
		expect(trace).toEqual(["activate A", "deactivate A", "activate B", "deactivate consumer", "deactivate B"]);
		expect(() => retained!.read(BACKGROUND_CONTEXT)).toThrow(
			"Facet terminal-consumer service handles cannot be used while dead",
		);
		await expect(host.reload([])).rejects.toThrow("Facet host cannot reload while dead");
		expect(() => host.services.use(RemoteGenerationValue)).toThrow("Remote service provider is disposed");
		await host.dispose();
	});

	test("creates a reusable static loader", async () => {
		const loader = createStaticFacetLoader([firstFacet]);
		const first = await loader.load();
		const second = await loader.load();
		expect(first.facets).toEqual([firstFacet]);
		expect(second.facets).toEqual([firstFacet]);
		await Promise.all([first.dispose(), second.dispose()]);
	});
});
