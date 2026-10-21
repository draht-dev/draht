import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "../../config.ts";
import type { ExtensionAPI } from "../extensions/types.ts";

/** Load the shared host policy from shipped assets, including the compiled-binary distribution. */
function loadGitSafetyPolicy(): (command: string) => string | undefined {
	const policy: unknown = createRequire(import.meta.url)(join(getPackageDir(), "hooks", "checks", "git-safety.cjs"));
	if (typeof policy !== "object" || policy === null || !("findGitSafetyViolation" in policy)) {
		throw new Error("Missing Git safety policy");
	}
	const check = policy.findGitSafetyViolation;
	if (typeof check !== "function") throw new Error("Invalid Git safety policy");
	return (command) => {
		const violation: unknown = check(command);
		if (violation !== undefined && typeof violation !== "string") throw new Error("Invalid Git safety result");
		return violation;
	};
}

export default function gitSafetyBuiltin(pi: ExtensionAPI) {
	let findViolation: ReturnType<typeof loadGitSafetyPolicy> | undefined;
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		if (typeof event.input.command !== "string") return;
		// A broken asset must reject protected calls, not discard this extension at startup.
		findViolation ??= loadGitSafetyPolicy();
		const reason = findViolation(event.input.command);
		if (reason) return { block: true, reason };
	});
}
