import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/version.ts";
import { tempRoot } from "./helpers/cli.ts";

const PKG_ROOT = packageRoot();
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const GATE = join(REPO_ROOT, "scripts", "check-install-publishable.mjs");

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [GATE, ...args], { cwd: REPO_ROOT });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

/** Builds a miniature repo root the gate can be pointed at. */
function fixtureRoot(options: { private?: boolean; tests?: Record<string, string> }): {
	path: string;
	dispose: () => void;
} {
	const tmp = tempRoot("release-gate");
	const installDir = join(tmp.path, "packages", "install");
	mkdirSync(join(installDir, "test", "e2e"), { recursive: true });
	writeFileSync(
		join(installDir, "package.json"),
		`${JSON.stringify({ name: "@draht/install", version: "0.0.0", private: options.private }, null, 2)}\n`,
	);
	for (const [relative, body] of Object.entries(options.tests ?? {})) {
		mkdirSync(join(installDir, relative, ".."), { recursive: true });
		writeFileSync(join(installDir, relative), body);
	}
	if (options.tests) {
		// Real vitest, resolved from this package's own dependencies.
		symlinkSync(join(PKG_ROOT, "node_modules"), join(installDir, "node_modules"));
	}
	return tmp;
}

describe("publication readiness gate", () => {
	it("passes while the package is private, without running the suite", async () => {
		const result = await run(["--root", REPO_ROOT]);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/private/i);
	});

	it("refuses publication when it is enabled but the package cannot build", async () => {
		const fixture = fixtureRoot({ private: false });
		try {
			const result = await run(["--root", fixture.path]);

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toMatch(/build script/);
		} finally {
			fixture.dispose();
		}
	});

	it("refuses publication when the release evidence tests fail", async () => {
		const fixture = fixtureRoot({
			private: false,
			tests: {
				"test/e2e/lifecycle.test.ts": `import { expect, it } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n`,
				"test/release-pipeline.test.ts": `import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
			},
		});
		try {
			const result = await run(["--root", fixture.path]);

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toMatch(/build script|did not pass|production floor/i);
		} finally {
			fixture.dispose();
		}
	}, 300_000);

	it("refuses publication when same-named evidence files are replaced by vacuous tests", async () => {
		const fixture = fixtureRoot({
			private: false,
			tests: {
				"test/e2e/lifecycle.test.ts": `import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
				"test/release-pipeline.test.ts": `import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
			},
		});
		try {
			const result = await run(["--root", fixture.path]);

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toMatch(/build script|production floor/);
		} finally {
			fixture.dispose();
		}
	}, 300_000);
});

describe("gate wiring", () => {
	const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

	it("is part of the repo-wide check", () => {
		expect(rootManifest.scripts["check:install-publishable"]).toContain("check-install-publishable.mjs");
		expect(rootManifest.scripts.check).toContain("check:install-publishable");
	});

	it("runs before any immutable release publication and again before npm publication", () => {
		const release = readFileSync(join(REPO_ROOT, "scripts", "release.mjs"), "utf8");
		const gates = [...release.matchAll(/check-install-publishable\.mjs/g)].map((match) => match.index ?? -1);
		const commitIndex = release.indexOf('git commit -m "release:');
		const tagIndex = release.indexOf("git tag v");
		const pushIndex = release.indexOf("git push origin main");
		const publishIndex = release.indexOf("publish-workspaces.mjs");

		expect(gates).toHaveLength(2);
		expect(gates[0]).toBeLessThan(commitIndex);
		expect(gates[0]).toBeLessThan(tagIndex);
		expect(gates[0]).toBeLessThan(pushIndex);
		expect(gates[1]).toBeLessThan(publishIndex);
		expect(gates[1]).toBeGreaterThan(pushIndex);
	});

	it("keeps the package private until publication is explicitly authorized", () => {
		expect(JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).private).toBe(true);
	});
});
