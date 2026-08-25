import { describe, expect, test, vi } from "vitest";
import { combineFacetLoaders, createStaticFacetLoader, type FacetLoader } from "../src/experimental/facet-loader.ts";
import { defineFacet } from "../src/experimental/facets.ts";

const firstFacet = defineFacet({ id: "first", setup() {} });
const secondFacet = defineFacet({ id: "second", setup() {} });

describe("experimental facet loader", () => {
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

	test("creates a reusable static loader", async () => {
		const loader = createStaticFacetLoader([firstFacet]);
		const first = await loader.load();
		const second = await loader.load();
		expect(first.facets).toEqual([firstFacet]);
		expect(second.facets).toEqual([firstFacet]);
		await Promise.all([first.dispose(), second.dispose()]);
	});
});
