/**
 * Mutation proofs for the geist wire gate (`scripts/check-geist-protocol.mjs`).
 *
 * A gate that cannot fail is worse than no gate, so every clause is driven here
 * against a deliberately broken input and asserted to name the break. Run under
 * bun rather than `node --test` because the clauses are exercised against the
 * REAL exported zod schemas, and zod resolves only from inside
 * packages/geist-protocol.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clauseDeclarationLocality,
	clauseMirrorDrift,
	clauseNoUnvalidatedFrame,
} from "./check-geist-protocol.mjs";
import { checkCorpus, hasMigrationNote, missingGoldens } from "./generate-geist-conformance.mjs";
import * as protocol from "../packages/geist-protocol/src/index.js";
import { ClientModeSchema, InputFrameSchema, OutputFrameSchema } from "../packages/geist-protocol/src/wire.js";

const scratch = mkdtempSync(join(tmpdir(), "geist-gate-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function writeSocketWire(name, body) {
	const path = join(scratch, `${name}.ts`);
	writeFileSync(path, body);
	return path;
}

const SOCKET_WIRE = `
export type ClientMode = "read-write" | "read-only";
export type ClientMessage = InputMessage;
export type ServerMessage = OutputMessage;
export interface InputMessage {
	type: "input";
	data: string;
	clientId: string;
}
export interface OutputMessage {
	type: "output";
	data: string;
	stream: "stdout" | "stderr";
}
`;

const FRAMES = [
	{ schema: "InputFrameSchema", socket: "InputMessage", added: [] },
	{ schema: "OutputFrameSchema", socket: "OutputMessage", added: [] },
];
const ENUMS = [{ schema: "ClientModeSchema", socket: "ClientMode" }];
const UNIONS = ["ClientMessage", "ServerMessage"];
const SCHEMAS = { ClientModeSchema, InputFrameSchema, OutputFrameSchema };

describe("clause C — mirror drift is not vacuous", () => {
	test("an untouched socket wire is clean", () => {
		const path = writeSocketWire("clean", SOCKET_WIRE);
		expect(clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS)).toEqual([]);
	});

	test("renaming a socket field is reported by name, on both sides", () => {
		const path = writeSocketWire(
			"renamed",
			SOCKET_WIRE.replace("\tdata: string;\n\tclientId", "\tpayload: string;\n\tclientId"),
		);
		const problems = clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS);
		expect(problems.some((p) => p.includes("InputFrameSchema.data") && p.includes("InputMessage"))).toBe(
			true,
		);
		expect(problems.some((p) => p.includes("InputMessage.payload") && p.includes("not mirrored"))).toBe(true);
	});

	test("changing a socket field's type is reported with both types", () => {
		const path = writeSocketWire(
			"retyped",
			SOCKET_WIRE.replace(`\tstream: "stdout" | "stderr";`, "\tstream: string;"),
		);
		const problems = clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS);
		expect(
			problems.some((p) => p.includes("OutputFrameSchema.stream") && p.includes("enum [stderr, stdout]")),
		).toBe(true);
	});

	test("making a socket field optional is reported", () => {
		const path = writeSocketWire("optional", SOCKET_WIRE.replace("\tclientId: string;", "\tclientId?: string;"));
		const problems = clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS);
		expect(problems.some((p) => p.includes("InputFrameSchema.clientId"))).toBe(true);
	});

	test("adding a socket message type that nothing mirrors is reported", () => {
		const path = writeSocketWire(
			"added-member",
			`${SOCKET_WIRE}\nexport interface ResizeMessage {\n\ttype: "resize";\n\tcols: number;\n}\n`.replace(
				"export type ClientMessage = InputMessage;",
				"export type ClientMessage = InputMessage | ResizeMessage;",
			),
		);
		const problems = clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS);
		expect(problems.some((p) => p.includes("ResizeMessage") && p.includes("no geist mirror"))).toBe(true);
	});

	test("changing the socket mode vocabulary is reported", () => {
		const path = writeSocketWire(
			"mode",
			SOCKET_WIRE.replace(`"read-write" | "read-only"`, `"read-write" | "read-only" | "admin"`),
		);
		const problems = clauseMirrorDrift(path, SCHEMAS, FRAMES, ENUMS, UNIONS);
		expect(problems.some((p) => p.includes("ClientModeSchema") && p.includes("admin"))).toBe(true);
	});

	test("the real wire and the real socket wire agree", () => {
		expect(clauseMirrorDrift()).toEqual([]);
	});
});

describe("clause A — declaration locality is not vacuous", () => {
	const wireTypes = new Set([...protocol.CLIENT_FRAME_TYPES, ...protocol.SERVER_FRAME_TYPES]);

	function scanDir(name, file, source) {
		const dir = join(scratch, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), source);
		return clauseDeclarationLocality(wireTypes, "type", [name], scratch);
	}

	test("a file that only constructs frames is clean", () => {
		const problems = scanDir(
			"constructs",
			"bridge.ts",
			`import { OutputFrameSchema } from "@draht/geist-protocol";\nconst frame = { type: "output", data: "x", stream: "stdout" };\nexport const parsed = OutputFrameSchema.parse(frame);\n`,
		);
		expect(problems).toEqual([]);
	});

	test("an unrelated string union that happens to contain a wire word is clean", () => {
		const problems = scanDir(
			"levels",
			"logger.ts",
			`type Level = "info" | "warn" | "error";\nexport type { Level };\n`,
		);
		expect(problems).toEqual([]);
	});

	test("re-declaring a frame's shape in an interface is reported", () => {
		const problems = scanDir(
			"redeclare",
			"frames.ts",
			`export interface OutputFrame {\n\ttype: "output";\n\tdata: string;\n\tstream: "stdout" | "stderr";\n}\n`,
		);
		expect(problems.some((p) => p.includes("frames.ts") && p.includes('"output"'))).toBe(true);
	});

	test("re-declaring a frame as a zod schema elsewhere is reported", () => {
		const problems = scanDir(
			"zod",
			"frames.ts",
			`import { z } from "zod";\nexport const MyOutput = z.object({ type: z.literal("output"), data: z.string() });\n`,
		);
		expect(problems.some((p) => p.includes("zod literal"))).toBe(true);
	});
});

describe("clause B — the rejection battery is not vacuous", () => {
	const battery = [
		{ name: "not-json", sent: "{not json", code: "invalid_frame", expectedCode: "invalid_frame", closed: true },
	];

	test("a daemon that answered every entry correctly is clean, apart from unrun entries", () => {
		const problems = clauseNoUnvalidatedFrame({ rejections: battery, transcript: [] });
		// Every REJECTED_FRAMES entry the fake recording omits must be reported as unrun.
		expect(problems.every((p) => p.includes("rejection battery did not run"))).toBe(true);
	});

	test("a daemon that answered with the wrong code is reported", () => {
		const problems = clauseNoUnvalidatedFrame({
			rejections: [{ ...battery[0], code: "unknown_type" }],
			transcript: [],
		});
		expect(problems.some((p) => p.includes("not-json") && p.includes("unknown_type"))).toBe(true);
	});

	test("a daemon that kept the connection open after refusing is reported", () => {
		const problems = clauseNoUnvalidatedFrame({ rejections: [{ ...battery[0], closed: false }], transcript: [] });
		expect(problems.some((p) => p.includes("kept the connection open"))).toBe(true);
	});

	test("a transcript frame no exported schema validates is reported", () => {
		const problems = clauseNoUnvalidatedFrame({
			rejections: [],
			transcript: [
				{ seq: 0, direction: "server-to-client", frame: { type: "output", data: "x", stream: "sideways" } },
			],
		});
		expect(problems.some((p) => p.includes("not validated by any exported schema"))).toBe(true);
	});
});

describe("clause D — corpus drift is not vacuous", () => {
	test("a byte change in a committed golden is reported with a named line diff", () => {
		const dir = join(scratch, "corpus-drift");
		mkdirSync(join(dir, "server-to-client"), { recursive: true });
		writeFileSync(join(dir, "server-to-client/output.json"), '{\n\t"frame": {\n\t\t"data": "recorded"\n\t}\n}\n');
		const problems = checkCorpus(
			[{ relPath: "server-to-client/output.json", content: '{\n\t"frame": {\n\t\t"data": "tampered"\n\t}\n}\n' }],
			dir,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("drift:");
		expect(problems[0]).toContain("line 3");
		expect(problems[0]).toContain('committed: "data": "recorded"');
		expect(problems[0]).toContain('recorded : "data": "tampered"');
	});

	test("a hand-added file next to the recorded goldens is reported", () => {
		const dir = join(scratch, "corpus-extra");
		mkdirSync(join(dir, "server-to-client"), { recursive: true });
		writeFileSync(join(dir, "server-to-client/output.json"), "x");
		writeFileSync(join(dir, "server-to-client/handwritten.json"), "x");
		const problems = checkCorpus([{ relPath: "server-to-client/output.json", content: "x" }], dir);
		expect(
			problems.some((p) => p.includes("handwritten.json") && p.includes("not produced by recording")),
		).toBe(true);
	});

	test("a declared message type with no golden is reported", () => {
		expect(missingGoldens([])).toEqual([
			...protocol.CLIENT_FRAME_TYPES.map((t) => `client-to-server/${t}.json`),
			...protocol.SERVER_FRAME_TYPES.map((t) => `server-to-client/${t}.json`),
		]);
	});

	test("a version with no migration note is reported", () => {
		const path = join(scratch, "MIGRATIONS.md");
		writeFileSync(path, "# notes\n\n## geist/9.9\n\nsomething else\n");
		expect(hasMigrationNote(protocol.GEIST_PROTOCOL_VERSION, path)).toBe(false);
		writeFileSync(path, `# notes\n\n## geist/${protocol.GEIST_PROTOCOL_VERSION}\n\nthe note\n`);
		expect(hasMigrationNote(protocol.GEIST_PROTOCOL_VERSION, path)).toBe(true);
	});

	test("the committed corpus really carries the migration note for the current version", () => {
		expect(hasMigrationNote()).toBe(true);
	});
});
