#!/usr/bin/env node
/**
 * Bridge from the host's hook runner to the Python judge hook.
 *
 *   node judge-hook.cjs PermissionRequest|Stop|UserPromptSubmit   (payload on stdin)
 *
 * Every other hook in this plugin is Node, and Node is guaranteed present
 * wherever the host runs; a Python interpreter is not (Windows in particular
 * ships none under the name `python3`). Calling the .py file directly from
 * hooks.json would therefore turn a missing interpreter into an error on every
 * prompt and every finished turn. This shim locates an interpreter instead and,
 * finding none, exits 0 — judge is simply inert, and the host's own permission
 * dialog appears exactly as it did before the plugin was installed.
 *
 * stdio is inherited so the hook payload on stdin and the hook's JSON reply on
 * stdout pass through untouched, and so a PermissionRequest can block for as
 * long as the human takes to swipe.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const event = process.argv[2];
const script = path.join(__dirname, "judge-hook.py");

const candidates = [
	["python3", [script, event]],
	// Windows: the launcher is the reliable way to reach a Python 3.
	...(process.platform === "win32" ? [["py", ["-3", script, event]]] : []),
	["python", [script, event]],
];

for (const [exe, args] of candidates) {
	const result = spawnSync(exe, args, { stdio: "inherit" });
	if (result.error) {
		if (result.error.code === "ENOENT") continue;
		break;
	}
	process.exit(result.status ?? 0);
}

process.exit(0);
