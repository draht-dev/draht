import { describe, expect, it } from "vitest";
import { type ComputePlanInput, computePlan, type DesiredComponent } from "../src/plan.ts";
import type { ComponentState, InstallState } from "../src/types.ts";

function makeState(components: Record<string, ComponentState> = {}): InstallState {
	return {
		schemaVersion: 1,
		channel: "latest",
		profile: { mode: "default", selectors: [] },
		components,
	};
}

function makeComponent(overrides: Partial<ComponentState> & Pick<ComponentState, "id" | "version">): ComponentState {
	return {
		kind: "claude-plugin",
		source: { npmName: `@draht/${overrides.id}`, resolvedVersion: overrides.version },
		files: [{ path: "index.js", sha256: "hash-a" }],
		effectiveness: "unknown",
		...overrides,
	};
}

function makeDesired(
	overrides: Partial<DesiredComponent> & Pick<DesiredComponent, "id" | "version">,
): DesiredComponent {
	return {
		kind: "claude-plugin",
		source: { npmName: `@draht/${overrides.id}`, resolvedVersion: overrides.version },
		...overrides,
	};
}

const noDiskFiles = (): null => null;

describe("computePlan", () => {
	it("plans an install for a component absent from state", () => {
		const desired = [makeDesired({ id: "foo", version: "1.0.0" })];
		const state = makeState();

		const result = computePlan({ desired, state, diskFiles: noDiskFiles });

		expect(result).toEqual({
			actions: [
				{
					type: "install",
					componentId: "foo",
					kind: "claude-plugin",
					toVersion: "1.0.0",
					source: desired[0].source,
				},
			],
			blocked: [],
		});
	});

	it("plans an update when the desired version is higher than installed", () => {
		const desired = [makeDesired({ id: "foo", version: "2.0.0" })];
		const state = makeState({ foo: makeComponent({ id: "foo", version: "1.0.0" }) });

		const result = computePlan({ desired, state, diskFiles: noDiskFiles });

		expect(result).toEqual({
			actions: [
				{
					type: "update",
					componentId: "foo",
					kind: "claude-plugin",
					toVersion: "2.0.0",
					fromVersion: "1.0.0",
					source: desired[0].source,
				},
			],
			blocked: [],
		});
	});

	it("produces no action when the version matches and on-disk hashes match state (idempotence)", () => {
		const installed = makeComponent({ id: "foo", version: "1.0.0" });
		const desired = [makeDesired({ id: "foo", version: "1.0.0" })];
		const state = makeState({ foo: installed });

		const result = computePlan({
			desired,
			state,
			// A freshly-built array with equal values, not the same reference as installed.files.
			diskFiles: () => [{ path: "index.js", sha256: "hash-a" }],
		});

		expect(result).toEqual({ actions: [], blocked: [] });
	});

	it("reinstalls when the version matches but the on-disk hash has drifted", () => {
		const installed = makeComponent({ id: "foo", version: "1.0.0" });
		const desired = [makeDesired({ id: "foo", version: "1.0.0" })];
		const state = makeState({ foo: installed });

		const result = computePlan({
			desired,
			state,
			diskFiles: () => [{ path: "index.js", sha256: "drifted-hash" }],
		});

		expect(result).toEqual({
			actions: [
				{
					type: "install",
					componentId: "foo",
					kind: "claude-plugin",
					toVersion: "1.0.0",
					source: desired[0].source,
				},
			],
			blocked: [],
		});
	});

	it("reinstalls when the version matches but the on-disk files are missing entirely", () => {
		const installed = makeComponent({ id: "foo", version: "1.0.0" });
		const desired = [makeDesired({ id: "foo", version: "1.0.0" })];
		const state = makeState({ foo: installed });

		const result = computePlan({ desired, state, diskFiles: noDiskFiles });

		expect(result).toEqual({
			actions: [
				{
					type: "install",
					componentId: "foo",
					kind: "claude-plugin",
					toVersion: "1.0.0",
					source: desired[0].source,
				},
			],
			blocked: [],
		});
	});

	it("blocks a downgrade instead of silently producing an action", () => {
		const installed = makeComponent({ id: "foo", version: "2.0.0" });
		const desired = [makeDesired({ id: "foo", version: "1.0.0" })];
		const state = makeState({ foo: installed });

		const result = computePlan({ desired, state, diskFiles: noDiskFiles });

		expect(result).toEqual({
			actions: [],
			blocked: [{ componentId: "foo", reason: "downgrade", from: "2.0.0", to: "1.0.0" }],
		});
	});

	it("only removes a component present in state but absent from desired when prune is true", () => {
		const installed = makeComponent({ id: "foo", version: "1.0.0" });
		const state = makeState({ foo: installed });

		const withoutPrune = computePlan({ desired: [], state, diskFiles: noDiskFiles });
		expect(withoutPrune).toEqual({ actions: [], blocked: [] });

		const withPrune = computePlan({ desired: [], state, diskFiles: noDiskFiles, prune: true });
		expect(withPrune).toEqual({
			actions: [{ type: "remove", componentId: "foo", kind: "claude-plugin", fromVersion: "1.0.0" }],
			blocked: [],
		});
	});

	it("orders installs/updates by componentId and always places removes last", () => {
		const state = makeState({ zeta: makeComponent({ id: "zeta", version: "1.0.0" }) });
		const desired = [
			makeDesired({ id: "charlie", version: "1.0.0" }),
			makeDesired({ id: "alpha", version: "1.0.0" }),
			makeDesired({ id: "bravo", version: "1.0.0" }),
		];

		const result = computePlan({ desired, state, diskFiles: noDiskFiles, prune: true });

		expect(result.actions.map((action) => action.componentId)).toEqual(["alpha", "bravo", "charlie", "zeta"]);
		expect(result.actions.at(-1)?.type).toBe("remove");
	});

	it("is pure: repeated calls with the same input are deep-equal and never mutate desired/state", () => {
		const installed = makeComponent({ id: "foo", version: "1.0.0" });
		const desired: DesiredComponent[] = [
			makeDesired({ id: "bar", version: "1.0.0" }),
			makeDesired({ id: "foo", version: "2.0.0" }),
		];
		const state = makeState({ foo: installed });
		const input: ComputePlanInput = {
			desired,
			state,
			diskFiles: () => [{ path: "index.js", sha256: "hash-a" }],
			prune: true,
		};

		const desiredSnapshot = JSON.parse(JSON.stringify(desired));
		const stateSnapshot = JSON.parse(JSON.stringify(state));

		const first = computePlan(input);
		const second = computePlan(input);

		expect(first).toEqual(second);
		expect(desired).toEqual(desiredSnapshot);
		expect(state).toEqual(stateSnapshot);
	});
});
