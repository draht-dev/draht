/**
 * `node dist/cli.js` and the compiled `dist/draht` must both work from one
 * build tree (Phase 32 D2).
 *
 * `build:binary` copies `package.json` into `dist/` — the compiled binary
 * resolves its assets relative to its own location, so it needs one there. The
 * Node entrypoint resolves assets by walking up from `dist/` looking for a
 * package.json, so that copy used to end the walk one directory too low: every
 * asset path then gained a phantom segment and `node dist/cli.js` died with
 * `ENOENT ... dist/dist/modes/interactive/theme/dark.json`. Whichever build ran
 * last decided which of the two entrypoints worked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPackageRoot } from "../src/config.ts";

describe("findPackageRoot", () => {
	let root: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "draht-pkg-root-")));
		fs.mkdirSync(path.join(root, "dist", "modes", "interactive", "theme"), { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@draht/coding-agent" }));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("resolves the package root from inside dist/ when no binary bundle copy exists", () => {
		expect(findPackageRoot(path.join(root, "dist", "modes", "interactive", "theme"))).toBe(root);
		expect(findPackageRoot(path.join(root, "dist"))).toBe(root);
	});

	it("still resolves the package root once build:binary has copied package.json into dist/", () => {
		fs.writeFileSync(path.join(root, "dist", "package.json"), JSON.stringify({ name: "@draht/coding-agent" }));

		expect(findPackageRoot(path.join(root, "dist", "modes", "interactive", "theme"))).toBe(root);
		expect(findPackageRoot(path.join(root, "dist"))).toBe(root);
	});

	it("treats a real package that happens to be named dist as a root", () => {
		// Only the emitted bundle is skipped, and only because its parent is the
		// package root. A standalone directory called "dist" is a package root.
		const standalone = path.join(root, "vendor", "dist");
		fs.mkdirSync(path.join(standalone, "lib"), { recursive: true });
		fs.writeFileSync(path.join(standalone, "package.json"), JSON.stringify({ name: "dist" }));

		expect(findPackageRoot(path.join(standalone, "lib"))).toBe(standalone);
	});
});
