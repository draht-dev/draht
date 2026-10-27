#!/usr/bin/env node
"use strict";
const { readFileSync } = require("node:fs");
try {
	const { runHook } = require("./budgets-runtime.cjs");
	runHook(process.argv[2], readFileSync(0, "utf8"));
} catch (error) {
	process.stderr.write(`Budget hook unavailable: ${error.message}\n`);
	process.exitCode = 2;
}
