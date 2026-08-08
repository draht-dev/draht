#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const EPSILON = 1e-9;
const REQUIRED_SPEC_FIELDS = [
	"schema_version",
	"style_id",
	"sequence_id",
	"intent",
	"duration_seconds",
	"aspect_ratio",
	"resolution",
	"continuity_anchor",
	"shots",
];
const REQUIRED_SHOT_FIELDS = ["start", "end", "shot_size", "subject", "action", "camera", "lighting", "audio", "transition"];

function fail(message) {
	throw new Error(message);
}

function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireText(value, label) {
	if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

function requireFiniteNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
}

function formatNumber(value) {
	return Number.isInteger(value) ? String(value) : String(value);
}

export function validateSpec(spec) {
	requireObject(spec, "spec");
	for (const field of REQUIRED_SPEC_FIELDS) {
		if (!(field in spec)) fail(`missing required field: ${field}`);
	}
	for (const field of ["schema_version", "style_id", "sequence_id", "intent", "aspect_ratio", "resolution"]) {
		requireText(spec[field], field);
	}
	requireFiniteNumber(spec.duration_seconds, "duration_seconds");
	if (spec.duration_seconds <= 0) fail("duration_seconds must be greater than zero");
	requireObject(spec.continuity_anchor, "continuity_anchor");
	if (!Array.isArray(spec.shots) || spec.shots.length === 0) fail("shots must contain at least one shot");

	let cursor = 0;
	for (const [index, shot] of spec.shots.entries()) {
		requireObject(shot, `shot ${index}`);
		for (const field of REQUIRED_SHOT_FIELDS) {
			if (!(field in shot)) fail(`shot ${index} is missing required field: ${field}`);
		}
		requireFiniteNumber(shot.start, `shot ${index}.start`);
		requireFiniteNumber(shot.end, `shot ${index}.end`);
		if (Math.abs(shot.start - cursor) > EPSILON) {
			fail(`shot ${index} must start at ${formatNumber(cursor)}; got ${formatNumber(shot.start)}`);
		}
		if (shot.end <= shot.start) fail(`shot ${index} must end after it starts`);
		for (const field of REQUIRED_SHOT_FIELDS.filter((field) => field !== "start" && field !== "end")) {
			requireText(shot[field], `shot ${index}.${field}`);
		}
		if ("dialogue" in shot && typeof shot.dialogue !== "string") fail(`shot ${index}.dialogue must be a string`);
		cursor = shot.end;
	}
	if (Math.abs(cursor - spec.duration_seconds) > EPSILON) {
		fail(`shots must end at duration_seconds ${formatNumber(spec.duration_seconds)}; got ${formatNumber(cursor)}`);
	}
	if (spec.negative_constraints !== undefined && !Array.isArray(spec.negative_constraints)) {
		fail("negative_constraints must be an array");
	}
	if (spec.provider_adapters !== undefined) requireObject(spec.provider_adapters, "provider_adapters");
	return spec;
}

function promptFor(spec) {
	const anchor = spec.continuity_anchor;
	const lines = [
		`Create a ${formatNumber(spec.duration_seconds)}-second provider-neutral cinematic continuation in ${spec.aspect_ratio} at ${spec.resolution}.`,
		`Creative intent: ${spec.intent}`,
		"Continuity anchor:",
	];
	for (const [key, value] of Object.entries(anchor)) {
		if (key === "reference_images" || key === "reference_videos" || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		lines.push(`- ${key.replaceAll("_", " ")}: ${Array.isArray(value) ? value.join(", ") : value}`);
	}
	lines.push("Timed shot plan:");
	for (const shot of spec.shots) {
		lines.push(
			`- ${shot.start.toFixed(2)}-${shot.end.toFixed(2)}s | ${shot.shot_size} | subject: ${shot.subject} | action: ${shot.action} | camera: ${shot.camera} | lighting: ${shot.lighting} | audio: ${shot.audio} | dialogue: ${shot.dialogue ?? ""} | transition: ${shot.transition}`,
		);
	}
	if (spec.negative_constraints?.length) lines.push(`Hard negative constraints: ${spec.negative_constraints.join("; ")}.`);
	return lines.join("\n");
}

function compileSeedanceAdapter(spec, masterPrompt) {
	const requested = spec.provider_adapters?.seedance_2_5;
	if (!requested) return undefined;
	requireObject(requested, "provider_adapters.seedance_2_5");
	const referenceImages = requested.image_urls?.length
		? requested.image_urls
		: (spec.continuity_anchor.reference_images ?? []);
	return {
		boundary_status: "Adapter assumptions only; validate the selected provider endpoint before submission.",
		prompt: masterPrompt,
		duration_seconds: spec.duration_seconds,
		aspect_ratio: spec.aspect_ratio,
		resolution: spec.resolution,
		model_hint: requested.model ?? null,
		reference_images: referenceImages,
		extra_options: requested.extra_options ?? {},
	};
}

export function compileSpec(input) {
	const spec = validateSpec(input);
	const masterPrompt = promptFor(spec);
	const providerAdapters = {};
	const seedance = compileSeedanceAdapter(spec, masterPrompt);
	if (seedance) providerAdapters.seedance_2_5 = seedance;
	return {
		schema_version: spec.schema_version,
		style_id: spec.style_id,
		sequence_id: spec.sequence_id,
		master_prompt: masterPrompt,
		provider_adapters: providerAdapters,
	};
}

function parseArgs(argv) {
	const args = argv.slice(2);
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		return { help: true };
	}
	const spec = args[0];
	let output = null;
	for (let index = 1; index < args.length; index++) {
		if (args[index] === "--output" || args[index] === "-o") {
			output = args[++index];
			if (!output) fail("--output requires a path");
		} else {
			fail(`unknown argument: ${args[index]}`);
		}
	}
	return { help: false, spec, output };
}

function main() {
	try {
		const args = parseArgs(process.argv);
		if (args.help) {
			process.stdout.write("Usage: node compile-continuation.mjs <sequence.json> [--output <compiled.json>]\n");
			return;
		}
		const input = JSON.parse(readFileSync(resolve(args.spec), "utf8"));
		const encoded = `${JSON.stringify(compileSpec(input), null, 2)}\n`;
		if (args.output) writeFileSync(resolve(args.output), encoded);
		else process.stdout.write(encoded);
	} catch (error) {
		process.stderr.write(`error: ${error.message}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
