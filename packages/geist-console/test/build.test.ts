import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const VITE_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "vite");

/**
 * Proves M1's "no restyle-later debt" requirement (spec §16) at the build-artifact
 * level, not just in source: the design tokens must actually be wired through a real
 * `vite build`, not merely sitting unused in tokens.css.
 */
describe("vite build", () => {
	test("dist/index.html links a stylesheet whose built CSS defines --smoke-900", () => {
		const outDir = mkdtempSync(join(tmpdir(), "geist-console-dist-"));
		try {
			execFileSync(VITE_BIN, ["build", "--outDir", outDir, "--emptyOutDir"], {
				cwd: PACKAGE_ROOT,
				stdio: "pipe",
			});

			const indexHtmlPath = join(outDir, "index.html");
			expect(existsSync(indexHtmlPath)).toBe(true);

			const indexHtml = readFileSync(indexHtmlPath, "utf-8");
			const cssHrefMatch = indexHtml.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/);
			expect(cssHrefMatch).not.toBeNull();

			const cssHref = cssHrefMatch?.[1] ?? "";
			const cssPath = join(outDir, cssHref.replace(/^\//, ""));
			expect(existsSync(cssPath)).toBe(true);

			const css = readFileSync(cssPath, "utf-8");
			expect(css).toContain("--smoke-900");
			expect(css).toContain("#0b0d10");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 30_000);
});
