#!/usr/bin/env node
"use strict";

/**
 * UserPromptSubmit Hook
 * Injects minimal draht planning context before each user prompt is sent to the model.
 * Only activates in projects with .planning/ and adds at most a short reminder line.
 * Keep output tiny — this runs on every prompt.
 */

const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const PLANNING = path.join(cwd, ".planning");

if (!fs.existsSync(PLANNING)) {
	process.exit(0);
}

const statePath = path.join(PLANNING, "STATE.md");
if (!fs.existsSync(statePath)) {
	process.exit(0);
}

try {
	const state = fs.readFileSync(statePath, "utf-8");
	const phaseMatch = state.match(/## Current Phase: (.+)/);
	const statusMatch = state.match(/## Status: (.+)/);
	if (phaseMatch && statusMatch) {
		// Print a single-line reminder. Claude Code prepends stdout to the prompt context.
		console.log(`[draht] ${phaseMatch[1].trim()} — ${statusMatch[1].trim()}`);
	}
} catch {}

process.exit(0);
