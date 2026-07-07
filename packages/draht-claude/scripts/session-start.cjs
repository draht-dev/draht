#!/usr/bin/env node
"use strict";

/**
 * Session Start Hook
 * Surfaces draht planning state when a Claude Code session starts in a project.
 * - Reports current phase and task from .planning/STATE.md
 * - Rereads the standing spec: vision + constraints from .planning/PROJECT.md
 *   (goal-drift guard — the spec reaches every session, not just milestones)
 * - Surfaces the most recent lessons from STATE.md ## Lessons
 * - Flags CONTINUE-HERE.md if the previous session was paused
 * - Silent in projects without .planning/
 */

const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const PLANNING = path.join(cwd, ".planning");

if (!fs.existsSync(PLANNING)) {
	// No draht planning — silent
	process.exit(0);
}

const lines = [];

// STATE.md — current phase + status
const statePath = path.join(PLANNING, "STATE.md");
if (fs.existsSync(statePath)) {
	try {
		const state = fs.readFileSync(statePath, "utf-8");
		const phaseMatch = state.match(/## Current Phase: (.+)/);
		const statusMatch = state.match(/## Status: (.+)/);
		const activityMatch = state.match(/## Last Activity: (.+)/);
		if (phaseMatch) lines.push(`Phase: ${phaseMatch[1].trim()}`);
		if (statusMatch) lines.push(`Status: ${statusMatch[1].trim()}`);
		if (activityMatch) lines.push(`Last activity: ${activityMatch[1].trim()}`);
	} catch {}
}

// PROJECT.md — standing spec digest (vision + constraints), reread every session
const projectPath = path.join(PLANNING, "PROJECT.md");
if (fs.existsSync(projectPath)) {
	try {
		const project = fs.readFileSync(projectPath, "utf-8");
		const visionMatch = project.match(/## Vision\s*\n([^\n#]+)/);
		if (visionMatch) {
			lines.push("");
			lines.push(`Vision: ${visionMatch[1].trim()}`);
		}
		const constraintsMatch = project.match(/## Constraints\s*\n([\s\S]*?)(?:\n## |$)/);
		if (constraintsMatch) {
			const constraints = constraintsMatch[1]
				.split("\n")
				.filter((l) => /^\s*[-*]\s/.test(l))
				.slice(0, 6);
			if (constraints.length > 0) {
				lines.push("Constraints:");
				for (const c of constraints) lines.push(c.trim());
			}
		}
	} catch {}
}

// STATE.md ## Lessons — most recent lessons, so past failures aren't repeated
if (fs.existsSync(statePath)) {
	try {
		const state = fs.readFileSync(statePath, "utf-8");
		const lessonsMatch = state.match(/## Lessons\s*\n([\s\S]*?)(?:\n## |$)/);
		if (lessonsMatch) {
			const lessons = lessonsMatch[1]
				.split("\n")
				.filter((l) => /^\s*[-*]\s/.test(l))
				.slice(-3);
			if (lessons.length > 0) {
				lines.push("");
				lines.push("Recent lessons:");
				for (const l of lessons) lines.push(l.trim());
			}
		}
	} catch {}
}

// CONTINUE-HERE.md — resume marker
const continuePath = path.join(PLANNING, "CONTINUE-HERE.md");
if (fs.existsSync(continuePath)) {
	lines.push("");
	lines.push("CONTINUE-HERE.md present — the previous session was paused.");
	lines.push("Run /resume-work to continue, or read .planning/CONTINUE-HERE.md for the handoff.");
}

if (lines.length > 0) {
	console.log("━ Draht planning state ━");
	for (const line of lines) console.log(line);
}

process.exit(0);
