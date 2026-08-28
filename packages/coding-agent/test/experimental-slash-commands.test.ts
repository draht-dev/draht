import { describe, expect, test, vi } from "vitest";
import { createFacetHost, defineFacet } from "../src/experimental/facets.ts";
import helloPluginFacet from "../src/experimental/plugins/hello.ts";
import { SlashCommands } from "../src/experimental/services/slash-commands.ts";
import {
	createSlashCommandsRuntimeFacet,
	SlashCommandRegistry,
} from "../src/experimental/services/slash-commands-provider.ts";

describe("experimental slash command facets", () => {
	test("registers and removes contributions", () => {
		const registry = new SlashCommandRegistry();
		const snapshots: string[][] = [];
		const unsubscribe = registry.subscribe((commands) => snapshots.push(commands.map(({ name }) => name)));
		const close = registry.register({ name: "hello", description: "Hello", run() {} });
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);
		expect(() => registry.register({ name: "hello", run() {} })).toThrow("already registered");
		close();
		close();
		expect(registry.list()).toEqual([]);
		expect(snapshots).toEqual([[], ["hello"], []]);
		unsubscribe();
	});

	test("tracks plugin facet reload and unload", async () => {
		const registry = new SlashCommandRegistry();
		const host = await createFacetHost({
			facets: [createSlashCommandsRuntimeFacet(registry), helloPluginFacet],
		});
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);

		const replacementRun = vi.fn();
		await host.reload([
			defineFacet({
				id: "@pi/example-hello",
				setup(env) {
					const commands = env.use(SlashCommands);
					env.onActivate(() =>
						env.own(commands.register({ name: "hello", description: "Replacement", run: replacementRun })),
					);
				},
			}),
		]);
		expect(registry.list()).toEqual([
			expect.objectContaining({ name: "hello", description: "Replacement", run: replacementRun }),
		]);

		await host.dispose();
		expect(registry.list()).toEqual([]);
	});
});
