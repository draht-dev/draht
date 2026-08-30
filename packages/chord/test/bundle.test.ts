import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { bundleFacets } from "../src/bundler.ts";
import { createFacetHost, defineFacet, defineService } from "../src/index.ts";
import {
	createFacetBundleArtifactLoader,
	createFacetBundleLoader,
	readFacetBundleArtifact,
	readFacetBundleManifest,
} from "../src/node.ts";

interface GenerationValue {
	read(): string;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];
const GenerationValue = defineService<GenerationValue>("test.bundle.generation", { local: true });

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("facet bundles", () => {
	test("builds independent content-addressed entries and loads fresh reloadable generations", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const sourceDirectory = join(directory, "src");
		const outputDirectory = join(directory, "bundle");
		await mkdir(sourceDirectory);
		await writeFile(
			join(sourceDirectory, "helper.ts"),
			'export const decorate = (value: string): string => "generation:" + value;\n',
		);
		const entryPath = join(sourceDirectory, "entry.ts");
		const presentationPath = join(sourceDirectory, "presentation.ts");
		await writeGeneration(entryPath, "A");
		await writeFile(presentationPath, 'export default { id: "bundle-presentation", setup() {} };\n');
		const facetEntries = { presentation: presentationPath, worker: entryPath };

		const firstBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "1" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		const firstEntry = firstBuild.manifest.entries.worker!;
		expect(firstEntry.file).toMatch(/^facet-[a-f0-9]{12}-[A-Z0-9]+\.js$/u);
		expect(firstEntry.sourceMap).toBe(`${firstEntry.file}.map`);
		expect(firstEntry.externalImports).toEqual(["@draht/chord"]);
		expect(firstBuild.manifest.entries.presentation!.file).not.toBe(firstEntry.file);
		expect((await readdir(outputDirectory)).filter((path) => path.endsWith(".js"))).toHaveLength(2);
		expect((await readFile(firstBuild.manifestPath, "utf8")).endsWith("\n")).toBe(true);

		const presentation = await createFacetBundleLoader({
			manifestPath: firstBuild.manifestPath,
			entry: "presentation",
		}).load();
		expect(presentation.facets.map(({ id }) => id)).toEqual(["bundle-presentation"]);
		await presentation.dispose();

		const artifact = await readFacetBundleArtifact({
			manifestPath: firstBuild.manifestPath,
			entry: "worker",
		});
		const materializedDirectory = join(directory, "materialized");
		const transported = await createFacetBundleArtifactLoader({
			artifact: structuredClone(artifact),
			temporaryDirectory: materializedDirectory,
		}).load();
		expect(transported.facets.map(({ id }) => id)).toEqual(["bundle-provider"]);
		expect(await readdir(materializedDirectory)).toHaveLength(1);
		await transported.dispose();
		expect(await readdir(materializedDirectory)).toEqual([]);

		const secondBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "1" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(secondBuild.manifest.entries.worker).toEqual(firstEntry);

		const loader = createFacetBundleLoader({ manifestPath: secondBuild.manifestPath, entry: "worker" });
		const loadedA = await loader.load();
		const loadedACopy = await loader.load();
		expect(loadedACopy.facets[0]).not.toBe(loadedA.facets[0]);
		await loadedACopy.dispose();

		let retained: GenerationValue | undefined;
		const consumer = defineFacet({
			id: "bundle-consumer",
			setup(env) {
				retained = env.use(GenerationValue);
			},
		});
		const host = await createFacetHost({ facets: [consumer, ...loadedA.facets] });
		expect(retained!.read()).toBe("generation:A");

		await writeGeneration(entryPath, "B");
		const thirdBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "2" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(thirdBuild.manifest.entries.worker!.file).not.toBe(firstEntry.file);
		const loadedB = await loader.load();
		await host.reload(loadedB.facets);
		await loadedA.dispose();
		expect(retained!.read()).toBe("generation:B");

		await host.dispose();
		await loadedB.dispose();
	});

	test("rejects corrupt entries and invalid module exports", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const entryPath = join(directory, "entry.ts");
		const outputDirectory = join(directory, "bundle");
		await writeFile(entryPath, "export default { id: 'missing-setup' };\n");
		const result = await bundleFacets({
			plugin: { id: "invalid-bundle" },
			entries: { invalid: entryPath },
			outdir: outputDirectory,
		});
		const loader = createFacetBundleLoader({ manifestPath: result.manifestPath, entry: "invalid" });
		await expect(loader.load()).rejects.toThrow("has no setup function");

		const manifest = await readFacetBundleManifest(result.manifestPath);
		await writeFile(join(outputDirectory, manifest.entries.invalid!.file), "export default {};\n");
		await expect(loader.load()).rejects.toThrow("integrity check failed");
	});
});

async function writeGeneration(path: string, generation: string): Promise<void> {
	await writeFile(
		path,
		`import "@draht/chord";\n` +
			`import { decorate } from "./helper.ts";\n` +
			`const Value = { id: "test.bundle.generation", local: true };\n` +
			`export default { id: "bundle-provider", setup(env) {\n` +
			`  env.provide(Value, { read() { return decorate(${JSON.stringify(generation)}); } });\n` +
			`}};\n`,
	);
}
