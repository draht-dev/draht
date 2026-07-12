import { describe, expect, test } from "bun:test";
import { FleetStateMessageSchema } from "../src/messages.js";

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
