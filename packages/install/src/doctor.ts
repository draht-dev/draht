import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "./adapters/index.ts";
import type { CatalogComponent } from "./catalog.ts";
import type { DetectionResult } from "./detect.ts";
import { filesEqual } from "./engine.ts";
import { hashTree } from "./hash.ts";
import { readJournal } from "./journal.ts";
import { lockFileExists, readLockFile } from "./lock.ts";
import { assessCrashedTransactions } from "./recovery.ts";
import { loadState, StateCorruptError } from "./state.ts";
import type { DoctorFinding, InstallState } from "./types.ts";
import { packageVersion } from "./version.ts";

export interface DoctorInput {
	root: string;
	home: string;
	catalog: CatalogComponent[];
	detection: DetectionResult;
	/** Resolves a component's payload target, or `null` for delegated components. */
	targetDirFor: (component: CatalogComponent) => string | null;
}

/**
 * Every diagnostic the engine can produce, as a stable list of
 * `{id, severity, message, repairable}`.
 *
 * `repairable` means *this engine can fix it automatically* — currently only
 * an interrupted transaction whose journal evidence is complete enough for
 * `recoverCrashedTransactions` to undo. Everything else is reported for a
 * human to act on rather than silently touched.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const { root, home, catalog, detection } = input;

	for (const executable of ["node", "npm"]) {
		if (!detection.hosts[executable]?.present) {
			findings.push({
				id: `${executable}-missing`,
				severity: executable === "node" ? "error" : "warn",
				message:
					executable === "node"
						? "node is not on PATH; components that shell out to node-based tooling will fail"
						: "npm is not on PATH; globally delegated components (the installer, the coding agent) cannot be installed or updated",
				repairable: false,
			});
		}
	}

	let state: InstallState | null = null;
	try {
		state = loadState(root);
	} catch (error) {
		if (error instanceof StateCorruptError) {
			findings.push({
				id: "state-corrupt",
				severity: "error",
				message: `${error.message}. Mutating commands are refused until this is resolved.`,
				repairable: false,
			});
		} else {
			throw error;
		}
	}

	try {
		const journal = readJournal(root);
		if (journal.torn) {
			findings.push({
				id: "journal-torn",
				severity: "warn",
				message:
					"the transaction journal's final line is incomplete, which means a process died mid-append; automatic transaction recovery is refused while this is true",
				repairable: false,
			});
		}
	} catch (error) {
		findings.push({
			id: "journal-corrupt",
			severity: "error",
			message: `the transaction journal cannot be read: ${(error as Error).message}`,
			repairable: false,
		});
	}

	const assessment = assessCrashedTransactions(root, { home, installRoot: root });
	for (const tx of assessment.transactions) {
		findings.push({
			id: `crashed-transaction:${tx}`,
			severity: "error",
			message: assessment.recoverable
				? `transaction ${tx} did not complete; the next mutating command will roll it back automatically from its journal and backups`
				: `transaction ${tx} did not complete and cannot be recovered automatically (${assessment.blockers.join("; ")})`,
			repairable: assessment.recoverable,
		});
	}

	if (lockFileExists(root)) {
		const owner = readLockFile(root);
		findings.push({
			id: "lock-present",
			severity: owner ? "info" : "warn",
			message: owner
				? `an install lock is held by pid ${owner.pid} on ${owner.hostname} (command "${owner.command}", since ${owner.startedAt})`
				: "an unreadable install lock file is present; mutating commands are refused until it is inspected and removed",
			repairable: false,
		});
	}

	if (state) {
		for (const [id, recorded] of Object.entries(state.components).sort(([a], [b]) => (a < b ? -1 : 1))) {
			const component = catalog.find((candidate) => candidate.id === id);
			if (!component) {
				findings.push({
					id: `unknown-component:${id}`,
					severity: "warn",
					message: `state records component "${id}", which this engine build has no catalog entry for`,
					repairable: false,
				});
				continue;
			}

			if (component.requiresHost && !detection.hosts[component.requiresHost]?.present) {
				findings.push({
					id: `host-missing:${id}`,
					severity: "warn",
					message: `component "${id}" is installed but its host CLI "${component.requiresHost}" is not on PATH`,
					repairable: false,
				});
			}

			if (recorded.delegated) continue;

			const target = input.targetDirFor(component);
			if (!target || !existsSync(target)) {
				findings.push({
					id: `payload-missing:${id}`,
					severity: "error",
					message: `component "${id}" is recorded as installed but its payload directory is gone; reinstall it with "draht-install install ${id}"`,
					repairable: false,
				});
				continue;
			}
			if (!filesEqual(await hashTree(target), recorded.files)) {
				findings.push({
					id: `hash-drift:${id}`,
					severity: "warn",
					message: `component "${id}" has been modified on disk since it was installed; "draht-install install ${id}" restores the recorded payload`,
					repairable: false,
				});
			}

			// Payload manifest version vs recorded version: a plugin whose shipped
			// manifest disagrees with what state records means someone replaced the
			// payload out of band.
			const adapter = adapterFor(component.kind);
			if (adapter.payload === "files") {
				const drift = payloadVersionDrift(target, recorded.version);
				if (drift) {
					findings.push({
						id: `manifest-version-drift:${id}`,
						severity: "warn",
						message: `component "${id}" records version ${recorded.version} but its installed manifest says ${drift}`,
						repairable: false,
					});
				}
			}
		}

		const installer = state.components.installer;
		if (installer) {
			const running = packageVersion();
			if (installer.version !== running) {
				findings.push({
					id: "installer-version-drift",
					severity: "info",
					message: `the running installer is ${running} but state records the installed installer component as ${installer.version}`,
					repairable: false,
				});
			}
		}
	}

	for (const legacy of detection.legacy) {
		findings.push({ id: legacy.id, severity: "warn", message: legacy.message, repairable: false });
	}

	return findings;
}

/** Reads the plugin payload's own manifest version, returning it only when it differs from what state records. */
function payloadVersionDrift(targetDir: string, recordedVersion: string): string | null {
	for (const relative of [join("plugins", "draht", "package.json"), "package.json"]) {
		const path = join(targetDir, relative);
		if (!existsSync(path)) continue;
		try {
			// Deliberately not zod-validated: this is third-party payload metadata,
			// and an unreadable manifest is simply "no drift signal", not an error.
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
			if (typeof parsed.version === "string" && parsed.version !== recordedVersion) return parsed.version;
			return null;
		} catch {
			return null;
		}
	}
	return null;
}
