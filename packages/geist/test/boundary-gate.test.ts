import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

	test("multiline dynamic imports cannot evade the boundary scan", () => {
		expect(runGate().exitCode).toBe(0);
		const file = join(REPO_ROOT, "packages", "geist-core", "src", "__boundary-mutation__.ts");
		withInjected(file, 'const forbidden = import(\n  "@draht/coding-agent"\n);\n', () => {
			const { exitCode, stderr } = runGate();
			expect(exitCode).toBe(1);
			expect(stderr).toContain("@draht/coding-agent");
		});
		expect(runGate().exitCode).toBe(0);
	});

	test("geist package manifests reject kernel and shim dependencies, nested fixtures included", () => {
		// A package.json dependency is the doorway a forbidden import walks
		// through later — the gate must fail on the declaration, not wait for
		// the first import. Nested manifests (test fixtures, examples) count
		// exactly like the package root's.
		expect(runGate().exitCode).toBe(0);

		const mutations = [
			{ field: "dependencies", dep: "@draht/coding-agent" },
			{ field: "devDependencies", dep: "@draht/draht-acp" },
		] as const;
		for (const { field, dep } of mutations) {
			const dir = join(REPO_ROOT, "packages", "geist-picker", "test", "__manifest-mutation__");
			mkdirSync(dir, { recursive: true });
			try {
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({ name: "boundary-mutation-fixture", [field]: { [dep]: "workspace:*" } }),
				);
				const { exitCode, stderr } = runGate();
				expect({ field, dep, exitCode }).toEqual({ field, dep, exitCode: 1 });
				expect(stderr).toContain(dep);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		expect(runGate().exitCode).toBe(0);
	});

	test("manifest aliases cannot redirect neutral names to forbidden Draht packages", () => {
		expect(runGate().exitCode).toBe(0);
		const dir = join(REPO_ROOT, "packages", "geist-picker", "test", "__manifest-alias-mutation__");
		mkdirSync(dir, { recursive: true });
		try {
			const manifestPath = join(dir, "package.json");
			for (const manifest of [
				{ dependencies: { neutral: "npm:@draht/coding-agent@2026.7.30" } },
				{ imports: { "#kernel": "@draht/coding-agent" } },
			]) {
				writeFileSync(manifestPath, JSON.stringify({ name: "boundary-alias-fixture", ...manifest }));
				const { exitCode, stderr } = runGate();
				expect(exitCode).toBe(1);
				expect(stderr).toContain("@draht/coding-agent");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(runGate().exitCode).toBe(0);
	});

	test("the gate fails loudly when a scanned surface is missing from the layout", () => {
		// A gate that shrugs when a scan target vanishes shrinks its own scope
		// silently — the exact failure mode the 2026-07-13 audit reopened this
		// phase for. The real script is copied into a synthetic repo so the real
		// worktree never has to lose a package to prove it.
		const tmpRoot = mkdtempSync(join(tmpdir(), "geist-boundary-"));
		const gateCopy = join(tmpRoot, "scripts", "check-geist-boundary.mjs");
		const runCopy = () => spawnSync(process.execPath, [gateCopy], { encoding: "utf-8" });
		try {
			mkdirSync(join(tmpRoot, "scripts"), { recursive: true });
			copyFileSync(GATE, gateCopy);
			for (const pkg of BOUNDARY_PACKAGES) {
				mkdirSync(join(tmpRoot, "packages", pkg, "src"), { recursive: true });
			}
			mkdirSync(join(tmpRoot, "quest"), { recursive: true });
			writeFileSync(join(tmpRoot, "quest", "Placeholder.kt"), "package dev.draht.geist\n");

			expect(runCopy().status).toBe(0);

			rmSync(join(tmpRoot, "packages", "geist-picker"), { recursive: true, force: true });
			const missingPackage = runCopy();
			expect({ what: "geist-picker gone", status: missingPackage.status }).toEqual({
				what: "geist-picker gone",
				status: 1,
			});
			expect(missingPackage.stderr).toContain("geist-picker");

			mkdirSync(join(tmpRoot, "packages", "geist-picker", "src"), { recursive: true });
			rmSync(join(tmpRoot, "quest"), { recursive: true, force: true });
			const missingQuest = runCopy();
			expect({ what: "quest gone", status: missingQuest.status }).toEqual({ what: "quest gone", status: 1 });
			expect(missingQuest.stderr).toContain("quest");
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test("quest/ stays out of npm workspaces: a package.json there fails the gate and no workspace glob reaches it", () => {
		// R31-FOUND.2: quest/ is Kotlin and must never become an npm workspace.
		// Enforced twice — the gate rejects any package.json under quest/, and
		// the root manifest's workspace globs must not be able to match quest/.
		expect(runGate().exitCode).toBe(0);

		const file = join(REPO_ROOT, "quest", "package.json");
		withInjected(file, JSON.stringify({ name: "quest", private: true }), () => {
			const { exitCode, stderr } = runGate();
			expect({ exitCode }).toEqual({ exitCode: 1 });
			expect(stderr).toContain("quest/ must NOT be an npm workspace");
		});

		const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
			workspaces: string[];
		};
		expect(rootManifest.workspaces.length).toBeGreaterThan(0);
		for (const glob of rootManifest.workspaces) {
			expect({ glob, reachesQuest: glob === "quest" || glob.startsWith("quest/") }).toEqual({
				glob,
				reachesQuest: false,
			});
		}

		expect(runGate().exitCode).toBe(0);
	});

	test("both geist gates stay wired into the repository check (R31-FOUND.5)", () => {
		// The beat's contract: mirror and boundary gates REMAIN wired into
		// `npm run check`. Pin the wiring so removing either script from the
		// root check chain fails a test, not just a reviewer's memory.
		const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
			scripts: Record<string, string>;
		};
		expect(rootManifest.scripts.check).toContain("check:geist-boundary");
		expect(rootManifest.scripts.check).toContain("check:geist-mirrors");
		expect(rootManifest.scripts["check:geist-boundary"]).toBe("node scripts/check-geist-boundary.mjs");
		expect(rootManifest.scripts["check:geist-mirrors"]).toBe("node scripts/check-geist-mirrors.mjs");

		// Both gates must actually run clean from the repo root right now.
		expect(runGate().exitCode).toBe(0);
		const mirrors = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-geist-mirrors.mjs")], {
			encoding: "utf-8",
		});
		expect(mirrors.status).toBe(0);
	});
});
