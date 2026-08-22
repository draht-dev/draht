/**
 * The geist/0.5 wire surface: `session_spawn`, `registry_resync` and their two
 * answers.
 *
 * A SCHEMA TEST, not a transport one. It proves what parses and what is
 * refused; it proves nothing about a daemon answering either verb. The corpus
 * under `conformance/geist-0.5/` is the recorded half, and no daemon starts a
 * process for `session_spawn` until the port behind it is wired.
 */

import { describe, expect, test } from "bun:test";
import {
	CLIENT_FRAME_TYPES,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	GEIST_PROTOCOL_VERSION,
	RegistryFrameSchema,
	RegistryResyncFrameSchema,
	SERVER_FRAME_TYPES,
	SessionSpawnedFrameSchema,
	SessionSpawnFrameSchema,
} from "../src/wire.js";

const spawnFrame = { type: "session_spawn" as const, harnessId: "draht", projectId: "fr3n" };
const registryFrame = {
	type: "registry" as const,
	harnesses: [{ id: "draht", isDefault: true }],
	projects: [{ id: "fr3n", name: "fr3n", root: "/work/fr3n" }],
};

describe("the published member is 0.5", () => {
	test("GEIST_PROTOCOL_VERSION is the current member", () => {
		expect(GEIST_PROTOCOL_VERSION).toBe("0.5");
	});

	test("the four 0.5 message types are declared, in the direction each belongs to", () => {
		expect([...CLIENT_FRAME_TYPES]).toContain("session_spawn");
		expect([...CLIENT_FRAME_TYPES]).toContain("registry_resync");
		expect([...SERVER_FRAME_TYPES]).toContain("session_spawned");
		expect([...SERVER_FRAME_TYPES]).toContain("registry");
		expect(
			[...CLIENT_FRAME_TYPES].filter((type) => (SERVER_FRAME_TYPES as readonly string[]).includes(type)),
		).toEqual([]);
	});
});

describe("session_spawn carries two registry ids and nothing else", () => {
	test("it round-trips decode to encode byte-identically", () => {
		const raw = encodeFrame(spawnFrame);
		const decoded = decodeClientFrame(raw);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(encodeFrame(decoded.frame)).toBe(raw);
	});

	test("a command, cwd or env smuggled alongside the ids does not survive the decoder", () => {
		// The whole of what keeps this from being an arbitrary-execution surface.
		// The frame still decodes — zod drops what it does not declare — so the
		// assertion is that the extra key is GONE, and that re-encoding what the
		// decoder yielded is not the bytes the caller sent.
		const raw = encodeFrame({
			...spawnFrame,
			command: ["/bin/sh", "-c", "touch $CANARY"],
			cwd: "/etc",
			env: { PATH: "/tmp/evil" },
		} as never);
		const decoded = decodeClientFrame(raw);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(Object.keys(decoded.frame).sort()).toEqual(["harnessId", "projectId", "type"]);
		expect(encodeFrame(decoded.frame)).not.toBe(raw);
	});

	test("a registry id that is a path fragment or prose is refused, in either position", () => {
		for (const bad of ["../etc", "a/b", "with space", ".hidden", "-lead", "", "x".repeat(65)]) {
			expect(SessionSpawnFrameSchema.safeParse({ ...spawnFrame, harnessId: bad }).success).toBe(false);
			expect(SessionSpawnFrameSchema.safeParse({ ...spawnFrame, projectId: bad }).success).toBe(false);
		}
		expect(SessionSpawnFrameSchema.safeParse({ ...spawnFrame, harnessId: "draht.v2_1-x" }).success).toBe(true);
		expect(SessionSpawnFrameSchema.safeParse({ ...spawnFrame, projectId: "x".repeat(64) }).success).toBe(true);
	});

	test("both ids are required", () => {
		const { harnessId: _h, ...noHarness } = spawnFrame;
		expect(SessionSpawnFrameSchema.safeParse(noHarness).success).toBe(false);
		const { projectId: _p, ...noProject } = spawnFrame;
		expect(SessionSpawnFrameSchema.safeParse(noProject).success).toBe(false);
	});
});

describe("registry_resync carries no fields", () => {
	test("it round-trips decode to encode byte-identically", () => {
		const raw = encodeFrame({ type: "registry_resync" });
		const decoded = decodeClientFrame(raw);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(encodeFrame(decoded.frame)).toBe(raw);
	});

	test("a filter sent alongside it does not survive the decoder", () => {
		const decoded = RegistryResyncFrameSchema.parse({ type: "registry_resync", projectId: "fr3n" });
		expect(Object.keys(decoded)).toEqual(["type"]);
		// `parse` drops UNDECLARED keys, so the line above holds for a schema declaring a filter of its own.
		expect(Object.keys(RegistryResyncFrameSchema.shape)).toEqual(["type"]);
	});
});

describe("session_spawned names an id only when there is one", () => {
	test("a refusal with no sessionId decodes and round-trips", () => {
		const raw = encodeFrame({
			type: "session_spawned",
			ok: false,
			code: "unknown_project",
			message: "no project with that id is registered",
		});
		const decoded = decodeServerFrame(raw);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect("sessionId" in decoded.frame).toBe(false);
		expect(encodeFrame(decoded.frame)).toBe(raw);
	});

	test("a success carrying the minted id round-trips", () => {
		const raw = encodeFrame({
			type: "session_spawned",
			sessionId: "01J000000000000000000000",
			ok: true,
			code: "spawned",
			message: "",
		});
		const decoded = decodeServerFrame(raw);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(encodeFrame(decoded.frame)).toBe(raw);
	});

	test("the sessionId is bounded, so a host that mints a long one cannot make the schema throw", () => {
		const answer = { type: "session_spawned", ok: true, code: "spawned", message: "" };
		expect(SessionSpawnedFrameSchema.safeParse({ ...answer, sessionId: "s".repeat(128) }).success).toBe(true);
		expect(SessionSpawnedFrameSchema.safeParse({ ...answer, sessionId: "s".repeat(129) }).success).toBe(false);
		expect(SessionSpawnedFrameSchema.safeParse({ ...answer, sessionId: "" }).success).toBe(false);
	});

	test("the code set is closed, and every member of it parses", () => {
		for (const code of ["spawned", "unknown_harness", "unknown_project", "refused", "spawn_failed", "timeout"]) {
			expect(
				SessionSpawnedFrameSchema.safeParse({ type: "session_spawned", ok: false, code, message: "" }).success,
			).toBe(true);
		}
		expect(
			SessionSpawnedFrameSchema.safeParse({ type: "session_spawned", ok: false, code: "not_found", message: "" })
				.success,
		).toBe(false);
	});

	test("a message carrying a control or bidi code point is refused by safeText", () => {
		// A spawn failure quotes a path and an errno, and a path is an
		// attacker-influenceable string.
		for (const message of ["ENOENT: /work/p", "ENOENT: /work/‮project"]) {
			expect(
				SessionSpawnedFrameSchema.safeParse({ type: "session_spawned", ok: false, code: "spawn_failed", message })
					.success,
			).toBe(false);
		}
	});
});

describe("registry describes what may be spawned, and no executable", () => {
	test("it round-trips decode to encode byte-identically", () => {
		const raw = encodeFrame(registryFrame);
		const decoded = decodeServerFrame(raw);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(encodeFrame(decoded.frame)).toBe(raw);
	});

	test("a harness row carries id and isDefault only — a cmd does not survive", () => {
		const parsed = RegistryFrameSchema.parse({
			...registryFrame,
			harnesses: [{ id: "draht", isDefault: true, cmd: "/usr/local/bin/draht" }],
		});
		expect(Object.keys(parsed.harnesses[0] ?? {}).sort()).toEqual(["id", "isDefault"]);
	});

	test("both arrays are bounded at 64 and 256, and accept exactly that many", () => {
		const harnesses = (count: number) => Array(count).fill({ id: "h", isDefault: false });
		const projects = (count: number) => Array(count).fill({ id: "p", name: "p", root: "/p" });
		expect(RegistryFrameSchema.safeParse({ ...registryFrame, harnesses: harnesses(64) }).success).toBe(true);
		expect(RegistryFrameSchema.safeParse({ ...registryFrame, harnesses: harnesses(65) }).success).toBe(false);
		expect(RegistryFrameSchema.safeParse({ ...registryFrame, projects: projects(256) }).success).toBe(true);
		expect(RegistryFrameSchema.safeParse({ ...registryFrame, projects: projects(257) }).success).toBe(false);
	});

	test("a harness or project id the wire refuses fails the frame, not just the row", () => {
		expect(
			RegistryFrameSchema.safeParse({ ...registryFrame, harnesses: [{ id: "bin/draht", isDefault: true }] }).success,
		).toBe(false);
		expect(
			RegistryFrameSchema.safeParse({ ...registryFrame, projects: [{ id: "draht mono", name: "d", root: "/d" }] })
				.success,
		).toBe(false);
	});

	test("a project name or root carrying a control or invisible code point is refused", () => {
		expect(
			RegistryFrameSchema.safeParse({ ...registryFrame, projects: [{ id: "p", name: "ab", root: "/p" }] }).success,
		).toBe(false);
		expect(
			RegistryFrameSchema.safeParse({ ...registryFrame, projects: [{ id: "p", name: "p", root: "/p​" }] }).success,
		).toBe(false);
	});
});
