#!/usr/bin/env bun
/**
 * The geist wire gate (R32-FLEET.4, R32-FLEET.5). Four clauses, all of which
 * fail root `npm run check`:
 *
 *   A. DECLARATION LOCALITY — a wire type declared anywhere but
 *      `packages/geist-protocol`. One shape, one declaration: the moment a
 *      renderer or a bridge writes its own `interface OutputFrame`, the two
 *      drift and nothing catches it.
 *
 *   B. NO UNVALIDATED FRAME — the daemon accepting bytes no exported schema
 *      validates. Proved by driving the running daemon with a battery of
 *      frames that must each be refused with a typed `protocol_error` on their
 *      own connection, and by re-validating every frame the daemon emitted.
 *
 *   C. MIRROR DRIFT — the relayed half of the wire drifting field-for-field
 *      from `packages/coding-agent/src/core/socket-server/types.ts`, the socket
 *      wire the bridge relays. Both directions: a geist field that the socket
 *      wire does not have, and a socket message type nothing mirrors.
 *
 *   D. CORPUS DRIFT — the committed conformance corpus no longer matching what
 *      the daemon puts on the wire, a declared message type with no golden, a
 *      schema change under an already-published `GEIST_PROTOCOL_VERSION`, or a
 *      version with no migration note.
 *
 * B and D share one recording of one daemon run, so the gate costs a single
 * daemon lifetime.
 *
 * Usage: bun scripts/check-geist-protocol.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "../packages/geist-protocol/src/index.js";
import { REJECTED_FRAMES, recordCorpus } from "./geist-conformance/record.mjs";
import { mirrorFields, parseSocketWireTypes } from "./geist-conformance/schema-shape.mjs";
import {
	checkCorpus,
	computeCorpusFiles,
	fingerprintProblems,
	hasMigrationNote,
	missingGoldens,
	schemaFingerprint,
	versionDir,
} from "./generate-geist-conformance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SOCKET_WIRE_TYPES = join(ROOT, "packages/coding-agent/src/core/socket-server/types.ts");

/**
 * Where a wire type must NOT be declared. The geist family minus the protocol
 * package itself, plus the daemon host, plus the recording harness — every
 * surface that touches a frame. `geist-protocol` is absent because it is the
 * one place a wire type belongs.
 */
const SCANNED_DIRS = [
	"packages/geist/src",
	"packages/geist/test",
	"packages/geist-core/src",
	"packages/geist-core/test",
	"packages/geist-acp/src",
	"packages/geist-picker/src",
	"packages/geist-console/src",
	"packages/gateway/src",
	"scripts/geist-conformance",
];

/**
 * The relayed half of the wire, and the socket-wire declaration each frame
 * mirrors. `added` is the closed set of fields this wire adds on purpose —
 * anything else, in either direction, is drift. Hand-maintained, in the same
 * spirit as `MIRRORED_SCHEMAS` in `check-geist-mirrors.mjs`: the table is the
 * record of what was decided, and the machinery below really fails when the
 * two sides move apart.
 */
const MIRRORED_FRAMES = [
	{ schema: "AttachFrameSchema", socket: "AttachMessage", added: ["sessionId"], structural: ["capabilities"] },
	{ schema: "InputFrameSchema", socket: "InputMessage", added: [] },
	{ schema: "DetachFrameSchema", socket: "DetachMessage", added: [] },
	{ schema: "OutputFrameSchema", socket: "OutputMessage", added: [] },
	{ schema: "InputEchoFrameSchema", socket: "InputEchoMessage", added: [] },
	{ schema: "ClientJoinedFrameSchema", socket: "ClientJoinedMessage", added: [] },
	{ schema: "ClientLeftFrameSchema", socket: "ClientLeftMessage", added: [] },
	{ schema: "SessionMetadataFrameSchema", socket: "SessionMetadataMessage", added: [] },
	{ schema: "ErrorFrameSchema", socket: "ErrorMessage", added: [] },
	{
		schema: "PermissionRequestFrameSchema",
		socket: "PermissionRequestMessage",
		added: [],
		structural: ["options", "deadline"],
	},
	{
		schema: "PermissionResolvedFrameSchema",
		socket: "PermissionResolvedMessage",
		added: [],
		structural: ["chosenOptionId", "clientId"],
	},
	{ schema: "PermissionResponseFrameSchema", socket: "PermissionResponseMessage", added: [] },
];

/** Socket-wire string-union aliases the geist wire mirrors as zod enums. */
const MIRRORED_ENUMS = [{ schema: "ClientModeSchema", socket: "ClientMode" }];

/** The socket-wire unions whose every member must be mirrored above. */
const MIRRORED_UNIONS = ["ClientMessage", "ServerMessage"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"];

function walk(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
	}
	return out;
}

/**
 * The line ranges of every `interface X { … }` / `type X = …` declaration.
 * Restricting the scan to declarations is what separates "this file DECLARES
 * the shape of an `output` frame" from "this file CONSTRUCTS one", which is
 * exactly what a bridge is supposed to do.
 */
function declarationRegions(source) {
	const lines = source.split("\n");
	const regions = [];
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*(export\s+)?(declare\s+)?(interface|type)\s+[A-Za-z0-9_$]+/.test(lines[i])) continue;
		let depth = 0;
		let seenBrace = false;
		let end = i;
		for (let j = i; j < lines.length; j++) {
			for (const char of lines[j]) {
				if (char === "{") {
					depth++;
					seenBrace = true;
				} else if (char === "}") depth--;
			}
			end = j;
			if (depth <= 0 && (seenBrace || /;\s*$/.test(lines[j]))) break;
		}
		regions.push({ start: i, end, text: lines.slice(i, end + 1).join("\n") });
		i = end;
	}
	return regions;
}

function clauseDeclarationLocality(wireTypes, discriminator, dirs = SCANNED_DIRS, root = ROOT) {
	const problems = [];
	// The discriminator as it appears in a TypeScript declaration — `type: "output"`
	// or `readonly type?: "output"` — never as an object literal being constructed,
	// which is exactly what a bridge is supposed to do with a frame it imported.
	const discriminatorDeclaration = new RegExp(`\\b${discriminator}\\s*\\??\\s*:\\s*"([^"]+)"`, "g");
	for (const dir of dirs) {
		for (const file of walk(join(root, dir))) {
			const source = readFileSync(file, "utf8");
			const rel = relative(root, file);

			for (const match of source.matchAll(/z\.literal\(\s*"([^"]+)"\s*\)/g)) {
				if (wireTypes.has(match[1])) {
					problems.push(`${rel}: declares wire type "${match[1]}" as a zod literal — wire types live only in packages/geist-protocol`);
				}
			}

			for (const region of declarationRegions(source)) {
				for (const match of region.text.matchAll(discriminatorDeclaration)) {
					if (!wireTypes.has(match[1])) continue;
					problems.push(
						`${rel}:${region.start + 1}: type declaration names wire type "${match[1]}" — import the schema from @draht/geist-protocol instead of re-declaring its shape`,
					);
				}
			}
		}
	}
	return problems;
}

/**
 * Fields whose type BOTH sides express in a word the shared vocabulary cannot
 * reduce further — an array element type, a `T | null`. `mirrorShape` collapses
 * a zod array to `opaque:array` and `parseSocketWireTypes` collapses
 * `PermissionOption[]` to `opaque:PermissionOption[]`, so comparing the two
 * words would report drift on two fields that agree.
 *
 * Named per row rather than inferred, and deliberately NOT the same escape as
 * `added`: a structural field must still EXIST on both sides with the same
 * optionality — only the type word goes uncompared. Everything flat around it,
 * which is nearly every field on the wire, is still compared exactly.
 */
function describeField(field) {
	const optional = field.optional ? "?" : "";
	if (field.type === "literal") return `${optional}literal ${JSON.stringify(field.value)}`;
	if (field.type === "enum") return `${optional}enum [${field.values.join(", ")}]`;
	return `${optional}${field.type}`;
}

function sameField(a, b) {
	return describeField(a) === describeField(b);
}

function clauseMirrorDrift(
	socketTypesPath = SOCKET_WIRE_TYPES,
	schemas = protocol,
	frames = MIRRORED_FRAMES,
	enums = MIRRORED_ENUMS,
	unions = MIRRORED_UNIONS,
) {
	const problems = [];
	const socket = parseSocketWireTypes(socketTypesPath);

	for (const { schema, socket: socketName, added, structural = [] } of frames) {
		const zodSchema = schemas[schema];
		if (!zodSchema) {
			problems.push(`"${schema}" is listed as mirrored but is not exported from @draht/geist-protocol`);
			continue;
		}
		const socketFields = socket.interfaces[socketName];
		if (!socketFields) {
			problems.push(`${socketTypesPath} no longer declares "${socketName}", mirrored by ${schema}`);
			continue;
		}
		const geistFields = mirrorFields(zodSchema);
		const declaredAdditions = new Set(added);
		const structuralFields = new Set(structural);

		for (const [name, field] of Object.entries(geistFields)) {
			if (declaredAdditions.has(name)) continue;
			const counterpart = socketFields[name];
			if (!counterpart) {
				problems.push(
					`${schema}.${name} (${describeField(field)}) has no counterpart in ${socketName} — add it to the mirror table's \`added\` list if it is a deliberate addition`,
				);
				continue;
			}
			if (structuralFields.has(name)) {
				if (field.optional !== counterpart.optional) {
					problems.push(
						`${schema}.${name} is ${field.optional ? "optional" : "required"} but ${socketName}.${name} is ${counterpart.optional ? "optional" : "required"}`,
					);
				}
				continue;
			}
			if (!sameField(field, counterpart)) {
				problems.push(`${schema}.${name} is ${describeField(field)} but ${socketName}.${name} is ${describeField(counterpart)}`);
			}
		}
		for (const name of structuralFields) {
			if (geistFields[name] && socketFields[name]) continue;
			problems.push(`the mirror table calls ${schema}.${name} structural, but one of the two sides has no such field`);
		}
		for (const name of Object.keys(socketFields)) {
			if (geistFields[name]) continue;
			problems.push(`${socketName}.${name} (${describeField(socketFields[name])}) is not mirrored by ${schema}`);
		}
		for (const name of declaredAdditions) {
			if (geistFields[name]) continue;
			problems.push(`the mirror table declares ${schema} adds "${name}", but the schema has no such field`);
		}
	}

	for (const { schema, socket: socketName } of enums) {
		const values = schemas[schema]?._def?.values;
		const socketValues = socket.aliases[socketName];
		if (!values) {
			problems.push(`"${schema}" is listed as mirrored but is not an exported zod enum`);
			continue;
		}
		if (!socketValues) {
			problems.push(`${socketTypesPath} no longer declares the string union "${socketName}", mirrored by ${schema}`);
			continue;
		}
		const left = [...values].sort().join(" | ");
		const right = [...socketValues].sort().join(" | ");
		if (left !== right) problems.push(`${schema} is [${left}] but ${socketName} is [${right}]`);
	}

	const mirroredSocketNames = new Set(frames.map((entry) => entry.socket));
	for (const union of unions) {
		const members = socket.unions[union];
		if (!members) {
			problems.push(`${socketTypesPath} no longer declares the union "${union}"`);
			continue;
		}
		for (const member of members) {
			if (!mirroredSocketNames.has(member)) {
				problems.push(`${union} member "${member}" has no geist mirror — add one to geist-protocol and to MIRRORED_FRAMES`);
			}
		}
	}
	return problems;
}

function clauseNoUnvalidatedFrame(recording) {
	const problems = [];
	const byName = new Map(recording.rejections.map((entry) => [entry.name, entry]));
	for (const candidate of REJECTED_FRAMES) {
		const answer = byName.get(candidate.name);
		if (!answer) {
			problems.push(`the daemon was never driven with "${candidate.name}" — the rejection battery did not run`);
			continue;
		}
		if (answer.code !== candidate.expect) {
			problems.push(`the daemon answered "${candidate.name}" with protocol_error ${answer.code}, expected ${candidate.expect}`);
		}
		if (!answer.closed) {
			problems.push(`the daemon kept the connection open after refusing "${candidate.name}"`);
		}
	}

	for (const entry of recording.transcript) {
		const decode = entry.direction === "client-to-server" ? protocol.decodeClientFrame : protocol.decodeServerFrame;
		const decoded = decode(JSON.stringify(entry.frame));
		if (!decoded.ok) {
			problems.push(`transcript entry ${entry.seq} (${entry.direction} ${entry.frame.type}) is not validated by any exported schema: ${decoded.message}`);
		}
	}
	return problems;
}

function clauseCorpusDrift(recording) {
	const fingerprint = schemaFingerprint();
	const files = computeCorpusFiles(recording, fingerprint);
	const dir = versionDir();
	const problems = [
		...missingGoldens(files).map((rel) => `no golden for a declared message type: ${rel}`),
		...fingerprintProblems(fingerprint, dir),
		...checkCorpus(files, dir),
	];
	if (!hasMigrationNote()) {
		problems.push(`packages/geist-protocol/conformance/MIGRATIONS.md has no "## geist/${protocol.GEIST_PROTOCOL_VERSION}" section`);
	}
	return problems;
}

function report(label, problems) {
	if (problems.length === 0) return false;
	console.error(`\n${label} (${problems.length} problem(s)):\n`);
	for (const problem of problems) console.error(`  ✗ ${problem}`);
	return true;
}

async function main() {
	if (!existsSync(SOCKET_WIRE_TYPES) || !statSync(SOCKET_WIRE_TYPES).isFile()) {
		console.error(`socket wire declarations not found at ${SOCKET_WIRE_TYPES}`);
		process.exit(1);
	}

	const wireTypes = new Set([...protocol.CLIENT_FRAME_TYPES, ...protocol.SERVER_FRAME_TYPES]);
	if (wireTypes.size === 0) {
		console.error("geist-protocol declares no wire types — this gate would be vacuous");
		process.exit(1);
	}

	let failed = false;
	const discriminator = protocol.ClientFrameSchema._def.discriminator;
	failed =
		report("A. wire types declared outside packages/geist-protocol", clauseDeclarationLocality(wireTypes, discriminator)) ||
		failed;
	failed = report("C. geist wire ↔ draht socket wire drift", clauseMirrorDrift()) || failed;

	let recording;
	try {
		recording = await recordCorpus();
	} catch (error) {
		// A daemon that cannot complete the scripted session is a gate failure with
		// a reason, not a stack trace: the usual cause is a schema that no longer
		// validates what the wire actually carries.
		report("B/D. recording the running daemon failed", [
			`${error.message}\n      The daemon could not complete the conformance session, so neither the frames it accepts\n      nor the corpus could be verified.`,
		]);
		process.exit(1);
	}
	failed = report("B. the daemon accepted a frame no exported schema validates", clauseNoUnvalidatedFrame(recording)) || failed;
	failed = report("D. conformance corpus drift", clauseCorpusDrift(recording)) || failed;

	if (failed) {
		console.error(
			"\nWire types live in packages/geist-protocol/src/wire.ts. After a deliberate change: bump GEIST_PROTOCOL_VERSION,\nadd a \"## geist/<version>\" note to packages/geist-protocol/conformance/MIGRATIONS.md, then run\n  bun scripts/generate-geist-conformance.mjs",
		);
		process.exit(1);
	}

	console.log(
		`geist wire clean — ${wireTypes.size} message type(s), ${MIRRORED_FRAMES.length} socket mirror(s), ${recording.rejections.length} refused frame(s), corpus geist/${protocol.GEIST_PROTOCOL_VERSION} matches the running daemon`,
	);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export {
	clauseDeclarationLocality,
	clauseMirrorDrift,
	clauseNoUnvalidatedFrame,
	declarationRegions,
	MIRRORED_ENUMS,
	MIRRORED_FRAMES,
	MIRRORED_UNIONS,
	SCANNED_DIRS,
	SOCKET_WIRE_TYPES,
};
