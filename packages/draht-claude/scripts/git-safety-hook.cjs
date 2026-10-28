#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { findGitSafetyViolation } = require("./git-safety.cjs");

try {
	const event = JSON.parse(fs.readFileSync(0, "utf8"));
	const input = event.tool_input ?? event.arguments ?? {};
	const command = input.command ?? input.cmd;
	if (typeof command === "string") {
		const violation = findGitSafetyViolation(command);
		if (violation) {
			process.stderr.write(`${violation}\n`);
			process.exitCode = 2;
		}
	}
} catch (error) {
	process.stderr.write(`Git safety hook could not inspect the tool input: ${error.message}\n`);
	process.exitCode = 2;
}
