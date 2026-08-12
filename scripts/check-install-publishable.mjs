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

		if (typeof manifest.scripts?.build !== "string") {
			fail(`publication is enabled but ${manifestPath} has no build script`);
		} else {
			const vitestCli = join(packageDir, "node_modules", "vitest", "dist", "cli.js");
			if (!existsSync(vitestCli)) {
				fail(`cannot verify release evidence: vitest is not installed at ${vitestCli}`);
			} else {
				const build = spawnSync("npm", ["run", "build"], {
					cwd: packageDir,
					encoding: "utf8",
					stdio: "pipe",
					timeout: 10 * 60 * 1000,
				});
				process.stdout.write(build.stdout ?? "");
				process.stderr.write(build.stderr ?? "");
				if (build.status !== 0) {
					fail("publication is enabled but the exact installer package did not build successfully");
					process.exit();
				}

				// The gate owns test selection: repository code cannot substitute two
				// vacuous same-named files for the actual package acceptance matrix.
				const result = spawnSync(process.execPath, [vitestCli, "--run"], {
					cwd: packageDir,
					encoding: "utf8",
					stdio: "pipe",
					timeout: 30 * 60 * 1000,
				});
				process.stdout.write(result.stdout ?? "");
				process.stderr.write(result.stderr ?? "");
				if (result.status !== 0) {
					fail(
						"publication is enabled but the complete installer acceptance suite did not pass. " +
							"Publication stays blocked until they do.",
					);
				} else {
					const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
					const files = /Test Files\s+(\d+) passed/.exec(output);
					const tests = /Tests\s+(\d+) passed/.exec(output);
					if (!files || !tests || Number(files[1]) < 20 || Number(tests[1]) < 900) {
						fail(
							`publication evidence is below the production floor (need at least 20 test files and 900 tests; observed ${files?.[1] ?? "unknown"} files and ${tests?.[1] ?? "unknown"} tests)`,
						);
						process.exit();
					}
					console.log("check-install-publishable: release evidence passed; publication is permitted.");
				}
			}
		}
	}
}
