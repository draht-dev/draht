#!/usr/bin/env bun
/**
 * Generate the geist wire conformance corpus by RECORDING A RUNNING DAEMON
 * (R32-FLEET.5) — the same generate-and-compare shape as
 * `scripts/generate-skills-artifacts.mjs --check`, with a recording where that
 * script has a file transform.
 *
 * The corpus is the frozen evidence of what `geist/0.x` version N actually put
 * on the wire: at least one golden per message type per direction, plus the
 * full ordered transcript and the battery of frames the daemon refused. None of
 * it is hand-authored; `--check` re-records against the live daemon and
 * byte-compares.
 *
 * Committed under `packages/geist-protocol/conformance/geist-<version>/`, keyed
 * on `GEIST_PROTOCOL_VERSION`. Alongside the goldens sits
 * `schema-fingerprint.json`, the structural descriptor of every wire schema at
 * the moment of recording. That file is what makes "no schema change without a
 * 0.x bump" mechanical: this generator REFUSES to overwrite a published
 * version's fingerprint with a different one, and the gate fails when the live
 * schemas no longer match the committed fingerprint. The only way forward is to
 * bump `GEIST_PROTOCOL_VERSION`, add a `## geist/<version>` note to
 * `conformance/MIGRATIONS.md`, and regenerate.
 *
 * Usage:
 *   bun scripts/generate-geist-conformance.mjs              # record + write
 *   bun scripts/generate-geist-conformance.mjs --check      # re-record, exit 1 on drift
 *   bun scripts/generate-geist-conformance.mjs --allow-version-rewrite
 *                                                           # republish this version (pre-freeze only)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../packages/geist-protocol/src/config.js";
import * as protocol from "../packages/geist-protocol/src/index.js";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "../packages/geist-protocol/src/index.js";
import { normalizedFieldsOf, recordCorpus } from "./geist-conformance/record.mjs";
import { describeSchema, isZodSchema } from "./geist-conformance/schema-shape.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const CONFORMANCE_ROOT = join(ROOT, "packages/geist-protocol/conformance");
export const MIGRATIONS_PATH = join(CONFORMANCE_ROOT, "MIGRATIONS.md");

/** Directory holding one published 0.x member's corpus. */
export function versionDir(version = GEIST_PROTOCOL_VERSION, root = CONFORMANCE_ROOT) {
	return join(root, `geist-${version}`);
}

/**
 * Structural descriptor of every wire schema geist-protocol exports, sorted by
 * name. Everything `config.ts` exports is subtracted: `geist.yaml` is a local
 * config contract, not something that crosses the wire, and adding a config
 * field must not force a protocol version bump on every renderer.
 */
export function schemaFingerprint(exports = protocol, excluded = new Set(Object.keys(config))) {
	const schemas = {};
	for (const name of Object.keys(exports).sort()) {
		if (excluded.has(name)) continue;
		if (name.endsWith("Schema") && isZodSchema(exports[name])) schemas[name] = describeSchema(exports[name]);
	}
	if (Object.keys(schemas).length === 0) throw new Error("no wire schemas found — the fingerprint would be vacuous");
	return { protocol: GEIST_PROTOCOL_FAMILY, version: GEIST_PROTOCOL_VERSION, schemas };
}

/**
 * Flatten a schema descriptor to `path → shape` leaves, so a fingerprint
 * mismatch can be reported as the fields that moved rather than as two walls of
 * JSON. Union options are keyed by their discriminator value where they have
 * one, so a change is attributed to `server_hello.limits.maxFrameBytes` rather
 * than to `options[0]`.
 */
export function flattenDescriptor(descriptor, prefix = "") {
	const leaves = {};
	if (!descriptor) return leaves;
	const at = (suffix) => (prefix ? `${prefix}.${suffix}` : suffix);
	switch (descriptor.kind) {
		case "object":
			for (const [name, field] of Object.entries(descriptor.fields)) Object.assign(leaves, flattenDescriptor(field, at(name)));
			return leaves;
		case "optional":
		case "nullable":
			for (const [path, shape] of Object.entries(flattenDescriptor(descriptor.inner, prefix))) leaves[path] = `${descriptor.kind} ${shape}`;
			return leaves;
		case "array":
			return flattenDescriptor(descriptor.element, at("[]"));
		case "record":
			return flattenDescriptor(descriptor.value, at("{}"));
		case "discriminatedUnion":
		case "union":
			for (const option of descriptor.options) {
				const tag = option.fields?.[descriptor.discriminator]?.value;
				Object.assign(leaves, flattenDescriptor(option, at(tag ?? "|")));
			}
			return leaves;
		default:
			leaves[prefix || "(root)"] = JSON.stringify(descriptor);
			return leaves;
	}
}

/** The field paths that were added, removed or retyped between two descriptors. */
export function describeDescriptorDiff(before, after, limit = 8) {
	const left = flattenDescriptor(before);
	const right = flattenDescriptor(after);
	const lines = [];
	for (const path of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
		if (left[path] === right[path]) continue;
		if (left[path] === undefined) lines.push(`+ ${path}: ${right[path]}`);
		else if (right[path] === undefined) lines.push(`- ${path}: ${left[path]}`);
		else lines.push(`~ ${path}: ${left[path]} → ${right[path]}`);
	}
	if (lines.length === 0) lines.push("(structurally identical — only ordering changed)");
	return lines.length > limit ? [...lines.slice(0, limit), `… and ${lines.length - limit} more`] : lines;
}

function serialize(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/**
 * Turn one recording into the exact set of files the corpus directory holds.
 * Returns `{ relPath, content }` records so both writing and checking work off
 * the same computation.
 */
export function computeCorpusFiles(recording, fingerprint) {
	const files = [
		{ relPath: "schema-fingerprint.json", content: serialize(fingerprint) },
		{ relPath: "transcript.json", content: serialize({ ...recording, rejections: undefined }) },
		{ relPath: "rejected-frames.json", content: serialize({ protocol: recording.protocol, version: recording.version, rejections: recording.rejections }) },
	];

	const seen = new Set();
	for (const entry of recording.transcript) {
		const key = `${entry.direction}/${entry.frame.type}`;
		if (seen.has(key)) continue;
		seen.add(key);
		files.push({
			relPath: `${key}.json`,
			content: serialize({
				protocol: recording.protocol,
				version: recording.version,
				direction: entry.direction,
				type: entry.frame.type,
				recordedFrom: recording.recordedFrom,
				normalizedFields: normalizedFieldsOf(entry.frame),
				frame: entry.frame,
			}),
		});
	}
	return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Every declared message type in each direction must have a golden. Derived
 * from the exported unions rather than a list kept here, so a schema added to a
 * union and nowhere else fails this rather than passing silently.
 */
export function missingGoldens(files) {
	const present = new Set(files.map((file) => file.relPath));
	const missing = [];
	for (const type of protocol.CLIENT_FRAME_TYPES) {
		if (!present.has(`client-to-server/${type}.json`)) missing.push(`client-to-server/${type}.json`);
	}
	for (const type of protocol.SERVER_FRAME_TYPES) {
		if (!present.has(`server-to-client/${type}.json`)) missing.push(`server-to-client/${type}.json`);
	}
	return missing;
}

/** Recursively list a directory's files as slash-joined relative paths. */
export function listFiles(dir, prefix = "") {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

/** Precise drift problems between a computed corpus and what is committed. */
export function checkCorpus(files, dir) {
	const problems = [];
	for (const file of files) {
		const path = join(dir, file.relPath);
		if (!existsSync(path)) {
			problems.push(`missing golden: ${path}`);
			continue;
		}
		const committed = readFileSync(path, "utf8");
		if (committed !== file.content) problems.push(`drift: ${path}\n${namedDiff(committed, file.content)}`);
	}
	const expected = new Set(files.map((file) => file.relPath));
	for (const rel of listFiles(dir)) {
		if (!expected.has(rel)) problems.push(`unexpected: ${join(dir, rel)} — not produced by recording the daemon`);
	}
	return problems;
}

/** First differing line, quoted from both sides — a diff a reader can act on. */
export function namedDiff(committed, recorded) {
	const left = committed.split("\n");
	const right = recorded.split("\n");
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		if (left[i] === right[i]) continue;
		return [
			`      line ${i + 1}`,
			`      committed: ${left[i] === undefined ? "(end of file)" : left[i].trim()}`,
			`      recorded : ${right[i] === undefined ? "(end of file)" : right[i].trim()}`,
		].join("\n");
	}
	return "      (files differ only in trailing bytes)";
}

/** Does MIGRATIONS.md carry a note for this 0.x member? */
export function hasMigrationNote(version = GEIST_PROTOCOL_VERSION, path = MIGRATIONS_PATH) {
	if (!existsSync(path)) return false;
	return new RegExp(`^##\\s+geist/${version.replace(".", "\\.")}\\s*$`, "m").test(readFileSync(path, "utf8"));
}

/**
 * Compare the live schemas against the fingerprint published under this
 * version. A difference means the wire moved without the version moving.
 */
export function fingerprintProblems(fingerprint, dir) {
	const path = join(dir, "schema-fingerprint.json");
	if (!existsSync(path)) return [`missing: ${path} — version ${GEIST_PROTOCOL_VERSION} has no published fingerprint`];
	const committed = readFileSync(path, "utf8");
	const recomputed = serialize(fingerprint);
	if (committed === recomputed) return [];
	const committedSchemas = JSON.parse(committed).schemas ?? {};
	const named = [];
	for (const name of [...new Set([...Object.keys(committedSchemas), ...Object.keys(fingerprint.schemas)])].sort()) {
		const before = committedSchemas[name];
		const after = fingerprint.schemas[name];
		if (JSON.stringify(before) === JSON.stringify(after)) continue;
		named.push(`    ${name}`);
		for (const line of describeDescriptorDiff(before, after)) named.push(`      ${line}`);
	}
	return [
		`the wire schemas changed but GEIST_PROTOCOL_VERSION is still ${GEIST_PROTOCOL_VERSION}:\n${named.join("\n")}`,
	];
}

async function main() {
	const check = process.argv.includes("--check");
	const allowRewrite = process.argv.includes("--allow-version-rewrite");
	const dir = versionDir();
	const fingerprint = schemaFingerprint();

	if (!check && !allowRewrite) {
		const problems = existsSync(join(dir, "schema-fingerprint.json")) ? fingerprintProblems(fingerprint, dir) : [];
		if (problems.length > 0) {
			console.error(`Refusing to republish geist/${GEIST_PROTOCOL_VERSION} over a different wire:\n`);
			for (const problem of problems) console.error(`  ✗ ${problem}`);
			console.error(
				`\nBump GEIST_PROTOCOL_VERSION in packages/geist-protocol/src/wire.ts, add a "## geist/<new>" note to\n${MIGRATIONS_PATH}, then re-run. Use --allow-version-rewrite only to re-record an unchanged wire.`,
			);
			process.exit(1);
		}
	}

	const recording = await recordCorpus();
	const files = computeCorpusFiles(recording, fingerprint);
	const missing = missingGoldens(files);
	if (missing.length > 0) {
		console.error(`The recording did not exercise every declared message type (${missing.length}):\n`);
		for (const rel of missing) console.error(`  ✗ ${rel}`);
		console.error("\nExtend the script in scripts/geist-conformance/record.mjs so the daemon really emits it.");
		process.exit(1);
	}

	if (check) {
		const problems = [...fingerprintProblems(fingerprint, dir), ...checkCorpus(files, dir)];
		if (!hasMigrationNote()) {
			problems.push(`${MIGRATIONS_PATH} has no "## geist/${GEIST_PROTOCOL_VERSION}" section`);
		}
		if (problems.length > 0) {
			console.error(`geist wire conformance drift (${problems.length} problem(s)):\n`);
			for (const problem of problems) console.error(`  ✗ ${problem}`);
			console.error("\nRun: bun scripts/generate-geist-conformance.mjs");
			process.exit(1);
		}
		console.log(`geist/${GEIST_PROTOCOL_VERSION} corpus matches the running daemon (${files.length} file(s))`);
		return;
	}

	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	for (const file of files) {
		const path = join(dir, file.relPath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, file.content);
		console.log(`+ ${path}`);
	}
	console.log(`${files.length} file(s) recorded for geist/${GEIST_PROTOCOL_VERSION}`);
	if (!hasMigrationNote()) {
		console.error(`\n✗ ${MIGRATIONS_PATH} still has no "## geist/${GEIST_PROTOCOL_VERSION}" section — the gate will fail until it does.`);
		process.exit(1);
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
