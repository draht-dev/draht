#!/usr/bin/env node
/**
 * Mechanical publication-readiness gate for `@draht/install`.
 *
 * The engine ships two bins that mutate a user's machine. Publishing it is
 * therefore gated on evidence, not on intent: while the package is `private`,
 * nothing can reach the registry and this gate is a no-op. The moment someone
 * removes `private` — the single action that authorizes publication — this
 * gate demands that the release-evidence suites exist AND pass, and fails the
 * repo-wide `npm run check` and the release script if they do not.
 *
 * Usage: node scripts/check-install-publishable.mjs [--root DIR]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Suites that must pass before the package may be published. */
const REQUIRED_EVIDENCE = [
	join("test", "e2e", "lifecycle.test.ts"),
	join("test", "release-pipeline.test.ts"),
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseRoot(argv) {
	const index = argv.indexOf("--root");
	return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

function fail(message) {
	console.error(`check-install-publishable: ${message}`);
	process.exitCode = 1;
}

const root = parseRoot(process.argv.slice(2));
const packageDir = join(root, "packages", "install");
const manifestPath = join(packageDir, "package.json");

if (!existsSync(manifestPath)) {
	fail(`no package manifest at ${manifestPath}`);
} else {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

	if (manifest.private === true) {
		console.log("check-install-publishable: @draht/install is private; publication is disabled and the gate does not apply.");
	} else {
		console.log(
			"check-install-publishable: @draht/install is publishable, so release evidence is required. Verifying...",
		);

		const missing = REQUIRED_EVIDENCE.filter((relative) => !existsSync(join(packageDir, relative)));
		if (missing.length > 0) {
			fail(
				`publication is enabled but required release evidence is missing: ${missing.join(", ")}. ` +
					`Restore these suites or set "private": true in ${manifestPath}.`,
			);
		} else {
			const vitestCli = join(packageDir, "node_modules", "vitest", "dist", "cli.js");
			if (!existsSync(vitestCli)) {
				fail(`cannot verify release evidence: vitest is not installed at ${vitestCli}`);
			} else {
				const result = spawnSync(process.execPath, [vitestCli, "--run", ...REQUIRED_EVIDENCE], {
					cwd: packageDir,
					encoding: "utf8",
					stdio: "pipe",
					timeout: 30 * 60 * 1000,
				});
				process.stdout.write(result.stdout ?? "");
				process.stderr.write(result.stderr ?? "");
				if (result.status !== 0) {
					fail(
						"publication is enabled but the release evidence suites did not pass. " +
							"Publication stays blocked until they do.",
					);
				} else {
					console.log("check-install-publishable: release evidence passed; publication is permitted.");
				}
			}
		}
	}
}
