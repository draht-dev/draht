#!/usr/bin/env node
/** Fail-closed publication-readiness gate for @draht/install. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
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

function evidencePaths(packageDir) {
	const paths = ["CHANGELOG.md", "README.md", "tsconfig.build.json", "tsconfig.json"];
	for (const tree of ["src", "test"]) {
		const walk = (relative) => {
			for (const entry of readdirSync(join(packageDir, relative), { withFileTypes: true })) {
				const child = join(relative, entry.name).replaceAll("\\", "/");
				if (entry.isDirectory()) walk(child);
				else if (entry.isFile()) paths.push(child);
			}
		};
		walk(tree);
	}
	return paths.sort();
}

function verifyEvidence(packageDir) {
	const evidencePath = join(packageDir, "release-evidence.sha256");
	if (!existsSync(evidencePath)) throw new Error(`missing trusted evidence manifest ${evidencePath}`);
	const text = readFileSync(evidencePath, "utf8").trim();
	const expected = new Map(
		text.split("\n").map((line) => {
			const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
			if (!match) throw new Error(`malformed evidence manifest line: ${line}`);
			return [match[2], match[1]];
		}),
	);
	const actual = evidencePaths(packageDir);
	if (actual.join("\n") !== [...expected.keys()].sort().join("\n")) {
		throw new Error("installer acceptance path set differs from the trusted release-evidence manifest");
	}
	for (const relative of actual) {
		const digest = createHash("sha256").update(readFileSync(join(packageDir, relative))).digest("hex");
		if (digest !== expected.get(relative)) throw new Error(`trusted evidence hash mismatch for ${relative}`);
	}
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
		console.log("check-install-publishable: @draht/install is publishable, so trusted release evidence is required. Verifying...");
		try {
			verifyEvidence(packageDir);
		} catch (error) {
			fail(`publication is enabled but trusted release evidence is invalid: ${error.message}`);
			process.exit();
		}

		const vitestCli = join(packageDir, "node_modules", "vitest", "dist", "cli.js");
		const tscCli = join(packageDir, "node_modules", "typescript", "bin", "tsc");
		if (!existsSync(vitestCli) || !existsSync(tscCli)) {
			fail("cannot verify release evidence: local TypeScript/Vitest tools are unavailable");
		} else {
			const build = spawnSync(process.execPath, [tscCli, "-p", "tsconfig.build.json"], {
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
			chmodSync(join(packageDir, "dist", "cli.js"), 0o755);

			const result = spawnSync(process.execPath, [vitestCli, "--run"], {
				cwd: packageDir,
				env: { ...process.env, DRAHT_INSTALL_PUBLICATION_GATE: "1" },
				encoding: "utf8",
				stdio: "pipe",
				timeout: 30 * 60 * 1000,
			});
			process.stdout.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
			if (result.status !== 0) {
				fail("publication is enabled but the trusted installer acceptance suite did not pass");
			} else {
				console.log("check-install-publishable: trusted release evidence passed; publication is permitted.");
			}
		}
	}
}
