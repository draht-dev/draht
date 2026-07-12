import { describe, expect, test } from "bun:test";
import { FleetStateMessageSchema, VariantsNewMessageSchema } from "../src/messages.js";

describe("FleetStateMessageSchema", () => {
	test("an empty fleet (no sessions, no configured agents) is schema-valid", () => {
		const message = {
			type: "fleet_state",
			payload: { sessions: [], agents: [] },
		};

		expect(FleetStateMessageSchema.parse(message)).toEqual(message);
	});

	test("accepts mixed-harness sessions across projects with capability badges", () => {
		const message = {
			type: "fleet_state",
			payload: {
				sessions: [
					{
						id: "session-1",
						projectSlug: "fr3n",
						harness: "draht",
						capabilities: { images: true, commands: true, modes: true, resume: false },
						status: "running",
					},
					{
						id: "session-2",
						projectSlug: "kintura",
						harness: "claude",
						capabilities: { images: false, commands: true, modes: false, resume: true },
						status: "awaiting_review",
					},
				],
				agents: [
					{ name: "draht", authOk: true },
					{ name: "claude", authOk: false },
				],
			},
		};

		expect(FleetStateMessageSchema.parse(message)).toEqual(message);
	});

	test("projectSlug is optional on a session (FleetRegistry does not yet track it)", () => {
		const message = {
			type: "fleet_state",
			payload: {
				sessions: [
					{
						id: "session-1",
						harness: "draht",
						capabilities: { images: true, commands: true, modes: true, resume: true },
						status: "stopped",
					},
				],
				agents: [],
			},
		};

		const parsed = FleetStateMessageSchema.parse(message);
		expect(parsed.payload.sessions[0]?.projectSlug).toBeUndefined();
	});

	test("rejects a session missing capabilities", () => {
		expect(() =>
			FleetStateMessageSchema.parse({
				type: "fleet_state",
				payload: { sessions: [{ id: "s1", harness: "draht" }], agents: [] },
			}),
		).toThrow();
	});

	test("rejects a session missing harness", () => {
		expect(() =>
			FleetStateMessageSchema.parse({
				type: "fleet_state",
				payload: {
					sessions: [{ id: "s1", capabilities: { images: true, commands: true, modes: true, resume: true } }],
					agents: [],
				},
			}),
		).toThrow();
	});

	test("rejects an agent missing authOk", () => {
		expect(() =>
			FleetStateMessageSchema.parse({
				type: "fleet_state",
				payload: { sessions: [], agents: [{ name: "draht" }] },
			}),
		).toThrow();
	});

	test("rejects a wrong message type literal", () => {
		expect(() =>
			FleetStateMessageSchema.parse({
				type: "not_fleet_state",
				payload: { sessions: [], agents: [] },
			}),
		).toThrow();
	});
});

describe("VariantsNewMessageSchema", () => {
	test("accepts a mixed-harness variants request (spec §16 M6: 'variants 3 with claude, codex and draht: …')", () => {
		const message = {
			type: "variants_new",
			payload: {
				count: 3,
				project: "fr3n",
				harnesses: ["claude", "codex", "draht"],
				text: "tighten the hero animation",
			},
		};

		expect(VariantsNewMessageSchema.parse(message)).toEqual(message);
	});

	test("accepts a request with harnesses omitted (every member falls back to the default harness)", () => {
		const message = {
			type: "variants_new",
			payload: {
				count: 3,
				project: "fr3n",
				text: "tighten the hero animation",
			},
		};

		const parsed = VariantsNewMessageSchema.parse(message);
		expect(parsed.payload.harnesses).toBeUndefined();
	});

	test("rejects count = 0 (spec §17.7 locked default of 3 applies upstream, but 0 is never valid on the wire)", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants_new",
				payload: { count: 0, project: "fr3n", text: "x" },
			}),
		).toThrow();
	});

	test("rejects a negative count", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants_new",
				payload: { count: -1, project: "fr3n", text: "x" },
			}),
		).toThrow();
	});

	test("rejects a non-integer count", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants_new",
				payload: { count: 1.5, project: "fr3n", text: "x" },
			}),
		).toThrow();
	});

	// Deliberate choice: an omitted `harnesses` field means "round-robin isn't
	// in play, every member uses the default harness" (undefined, valid — see
	// above); an explicit but EMPTY `harnesses: []` is a different, invalid
	// claim — "round-robin across a with-list" with nothing in it — so the two
	// are NOT treated as equivalent. `.min(1)` on the array (rather than a bare
	// `.optional()`) is what enforces the distinction.
	test("rejects an explicit empty harnesses array (distinct from omitting the field)", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants_new",
				payload: { count: 3, project: "fr3n", harnesses: [], text: "x" },
			}),
		).toThrow();
	});

	test("rejects a missing project (variants fan out from a single project, spec §12)", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants_new",
				payload: { count: 3, text: "x" },
			}),
		).toThrow();
	});

	test("rejects a wrong message type literal", () => {
		expect(() =>
			VariantsNewMessageSchema.parse({
				type: "variants",
				payload: { count: 3, project: "fr3n", text: "x" },
			}),
		).toThrow();
	});
});
