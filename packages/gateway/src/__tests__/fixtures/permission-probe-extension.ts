/**
 * The enumeration probe for R34-PERM.7 (T11).
 *
 * There is no way to enumerate draht's tool registry over any public protocol: the RPC command set
 * has no `get_tools` and the CLI has no `--list-tools`. The only honest hook is `pi.getAllTools()`,
 * and it exists only INSIDE a loaded extension — which is exactly where this file runs.
 *
 * It registers nothing. It prints ONE machine-readable line to stderr on `session_start`, after
 * every extension (including the ones passed with `-e` alongside this one) has finished
 * registering. Both lists matter and they differ: `all` is everything the registry holds, `active`
 * is the subset the tool loop can actually dispatch (`read`/`bash`/`edit`/`write` plus extension
 * tools by default), and a tool in `all` but not `active` is answered "Tool <name> not found"
 * before the permission gate is consulted at all. Reporting them from inside the process is what
 * stops the test's table being a list a test author typed out once and let rot.
 *
 * stderr, not stdout: stdout is the RPC channel in `--mode rpc` and a stray line there is a
 * protocol violation.
 */

import type { ExtensionAPI } from "@draht/coding-agent";

/** Prefix the test greps for. Keep in sync with permission-enumeration.e2e.test.ts. */
export const PROBE_PREFIX = "PERMISSION_PROBE_TOOLS ";

export default function permissionProbeExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const names = pi.getAllTools().map((tool) => tool.name);
		const active = pi.getActiveTools();
		process.stderr.write(`${PROBE_PREFIX}${JSON.stringify({ all: names, active })}\n`);
	});
}
