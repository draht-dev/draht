import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mutation proof for the geist import boundary (R31-FOUND.4, R31-FOUND.7).
 *
 * These tests run the real gate — scripts/check-geist-boundary.mjs — against
 * the real worktree, temporarily injecting a forbidden import into each
 * boundary-checked package and asserting the gate fails loudly. This is the
 * negative regression demanded by the 2026-07-13 audit: the gate must reject
 * both the Draht kernel (`@draht/coding-agent`) and the privileged shim
 * (`@draht/draht-acp`) from every non-shim geist package, independently.
 *
 * Injected files are uniquely named and removed in `finally`; if a crashed
 * run ever leaves one behind, the boundary gate itself fails the repository
 * check until it is deleted — the failure mode is loud, not silent.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "check-geist-boundary.mjs");

/** The six non-shim geist packages R31-FOUND.4 protects. */
const BOUNDARY_PACKAGES = [
	"geist",
	"geist-core",
	"geist-acp",
	"geist-protocol",
	"geist-picker",
	"geist-console",
] as const;

function runGate(): { exitCode: number; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [GATE], { encoding: "utf-8" });
	return { exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function withInjected(file: string, content: string, fn: () => void): void {
	writeFileSync(file, content);
	try {
		fn();
	} finally {
		rmSync(file, { force: true });
	}
}

describe("check-geist-boundary.mjs (R31-FOUND.7 mutations)", () => {
	test("every non-shim geist package rejects kernel and privileged-shim imports independently", () => {
		// Precondition: the untouched tree passes, so any failure below is caused
		// by the injected mutation alone.
		expect(runGate().exitCode).toBe(0);

		for (const pkg of BOUNDARY_PACKAGES) {
			for (const [dir, specifier] of [
				["src", "@draht/coding-agent"], // kernel import into the package's shipped code
				["test", "@draht/draht-acp"], // privileged-shim import into the package's tests
			] as const) {
				const file = join(REPO_ROOT, "packages", pkg, dir, "__boundary-mutation__.ts");
				withInjected(file, `import "${specifier}";\n`, () => {
					const { exitCode, stderr } = runGate();
					expect({ pkg, dir, specifier, exitCode }).toEqual({ pkg, dir, specifier, exitCode: 1 });
					expect(stderr).toContain("__boundary-mutation__.ts");
					expect(stderr).toContain(specifier);
				});
			}
		}

		// The mutations above were all cleaned up: the tree is green again.
		expect(runGate().exitCode).toBe(0);
	});

	test("quest/ rejects every @draht/* reference in any file, even inside comments", () => {
		// R31-FOUND.7's separate quest mutation: quest/ is Kotlin — the boundary
		// holds only if the gate reads every file as text, not just JS-shaped
		// import specifiers. A comment reference is enough to smuggle coupling
		// into review, so a comment reference is enough to fail the gate.
		expect(runGate().exitCode).toBe(0);

		const mutations = [
			{
				file: join(REPO_ROOT, "quest", "app", "__BoundaryMutation.kt"),
				content: "// mirrors @draht/geist-protocol FleetStateMessage by hand\n",
			},
			{
				file: join(REPO_ROOT, "quest", "__boundary-mutation__.gradle.kts"),
				content: 'val forbidden = "@draht/geist-core"\n',
			},
		];
		for (const { file, content } of mutations) {
			withInjected(file, content, () => {
				const { exitCode, stderr } = runGate();
				expect({ file, exitCode }).toEqual({ file, exitCode: 1 });
				expect(stderr).toContain("@draht/");
			});
		}

		expect(runGate().exitCode).toBe(0);
	});

	test("boundary packages reject relative imports that escape the package into the kernel", () => {
		// A relative specifier of ../../coding-agent/src/index.js names no
		// @draht/* scope, yet lands in the kernel all the same — a hard boundary
		// that only pattern-matches npm scopes is not hard. Any relative import
		// resolving outside its own package root must fail the gate.
		//
		// The fixture is assembled from parts because this test file itself lives
		// inside a boundary package: written as one plain string literal, the
		// gate's line scanner would (correctly) flag the fixture text as an
		// import-shaped escape. The injected file's bytes are identical.
		const escapeSpecifier = ["..", "..", "coding-agent", "src", "index.js"].join("/");
		const escapeImport = `import ${JSON.stringify(escapeSpecifier)};\n`;

		expect(runGate().exitCode).toBe(0);

		const file = join(REPO_ROOT, "packages", "geist-core", "src", "__boundary-mutation__.ts");
		withInjected(file, escapeImport, () => {
			const { exitCode, stderr } = runGate();
			expect({ exitCode }).toEqual({ exitCode: 1 });
			expect(stderr).toContain("__boundary-mutation__.ts");
		});

		expect(runGate().exitCode).toBe(0);
	});
});
