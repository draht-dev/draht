#!/usr/bin/env node
"use strict";

/**
 * UserPromptSubmit Hook
 * Injects minimal draht planning context before each user prompt is sent to the model.
 * Opt in with hooks.planningContext: true in .planning/config.json.
 * Keep output tiny — this runs on every prompt.
 */

const fs = require("node:fs");
const path = require("node:path");
const { stripVTControlCharacters } = require("node:util");

function cleanLine(value) {
	return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function readField(state, name) {
	const lines = state.split(/\r\n?|\n|\u2028|\u2029/);
	const inline = new RegExp(`^(?:## )?${name}: *(.*)$`);
	for (let index = 0; index < lines.length; index++) {
		const line = cleanLine(lines[index]);
		const match = line.match(inline);
		if (match?.[1]) return match[1];
		if (line !== `## ${name}` && line !== `## ${name}:`) {
			if (match) return "";
			continue;
		}
		for (const following of lines.slice(index + 1)) {
			const value = cleanLine(following);
			if (/^#{1,6} |^(?:Current Phase|Status):/.test(value)) return "";
			if (value) return value;
		}
		return "";
	}
	return "";
}

function shorten(value, limit) {
	const characters = Array.from(value);
	return characters.length > limit ? `${characters.slice(0, limit - 1).join("").trimEnd()}…` : value;
}

const cwd = process.cwd();
const PLANNING = path.join(cwd, ".planning");

try {
	const config = JSON.parse(fs.readFileSync(path.join(PLANNING, "config.json"), "utf-8"));
	if (config?.hooks?.planningContext !== true) process.exit(0);
} catch {
	process.exit(0);
}

const statePath = path.join(PLANNING, "STATE.md");
if (!fs.existsSync(statePath)) {
	process.exit(0);
}

try {
	const state = fs.readFileSync(statePath, "utf-8");
	const phase = shorten(readField(state, "Current Phase"), 64);
	const status = shorten(readField(state, "Status"), 120);
	if (phase && status) {
		// Print a single-line reminder. Codex prepends stdout to the prompt context.
		console.log(`[draht] ${phase} — ${status}`);
	}
} catch {}

process.exit(0);
