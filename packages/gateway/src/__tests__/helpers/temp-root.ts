/**
 * A canonical temp root that a root-owned link can also name: the path-gate tests alias it through `/var/run` on
 * Linux (`/private/var` on macOS), so a Linux root must live under `/run`. Candidates are probed by creating a
 * directory, because `/run/lock` is 1777 on some distributions and root-owned or read-only on others.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The failure reason, or `undefined` when a directory could be created and removed there. */
function whyUnwritable(dir: string): string | undefined {
	try {
		rmSync(mkdtempSync(join(dir, "temp-root-probe-")), { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

export function canonicalTempRoot(): string {
	if (process.platform !== "linux") return realpathSync(tmpdir());

	const failures: string[] = [];
	for (const candidate of ["/run/lock", `/run/user/${process.getuid?.() ?? 0}`]) {
		const reason = whyUnwritable(candidate);
		if (reason === undefined) return realpathSync(candidate);
		failures.push(`${candidate} (${reason})`);
	}
	throw new Error(`no writable Linux temp root reachable through /var/run: tried ${failures.join(" and ")}`);
}
