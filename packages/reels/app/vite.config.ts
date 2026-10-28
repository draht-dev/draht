import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { safeJoin } from "./src/lib/safeJoin.js";

/**
 * Serves app/dev-fixtures/*.json at the site root during `vite dev` only, so
 * `useRepoIndex`/`useFeed` can fetch `./repos.json` and `./<repo>/feed.json`
 * without a running pipeline. Never applied to `vite build`, so the fixtures
 * never ship in app/dist.
 */
function devFixturesPlugin(): Plugin {
	const fixturesDir = path.resolve(import.meta.dirname, "dev-fixtures");

	return {
		name: "reels-dev-fixtures",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const rawUrl = req.url?.split("?")[0];
				if (!rawUrl || !rawUrl.endsWith(".json")) {
					next();
					return;
				}

				let url;
				try {
					url = decodeURIComponent(rawUrl);
				} catch {
					res.statusCode = 404;
					res.end();
					return;
				}

				// req.url is attacker-controlled; a naive path.join would let a
				// "../" segment escape fixturesDir entirely (path traversal).
				const resolved = safeJoin(fixturesDir, url);
				if (!resolved) {
					res.statusCode = 404;
					res.end();
					return;
				}

				try {
					const data = await readFile(resolved);
					res.setHeader("Content-Type", "application/json");
					res.end(data);
				} catch {
					next();
				}
			});
		},
	};
}

/**
 * Stamps `public/sw.js`'s `__BUILD_ID__` placeholder with a hash of this
 * build's actual output filenames before writing it to `dist/sw.js`. Vite's
 * built-in `publicDir` copy also writes an unstamped `dist/sw.js`; this
 * plugin reads from the *source* file and overwrites that output directly,
 * so it is correct regardless of hook ordering between the two.
 *
 * The point is that sw.js's bytes differ on every build with different
 * output, including ones with unchanged app code paired with changed hashed
 * asset names — identical bytes are what make a browser treat a new service
 * worker install as a no-op, so a versioned, build-stable id is what makes
 * updates actually roll out (see sw.js's SHELL_CACHE).
 */
function swBuildIdPlugin(): Plugin {
	return {
		name: "reels-sw-build-id",
		apply: "build",
		async writeBundle(options, bundle) {
			const outDir = path.resolve(import.meta.dirname, options.dir ?? "dist");
			const sourceSwPath = path.resolve(import.meta.dirname, "public/sw.js");
			const assetNames = Object.keys(bundle).sort();
			const buildId = createHash("sha256").update(assetNames.join("\n")).digest("hex").slice(0, 12);
			const source = await readFile(sourceSwPath, "utf8");
			await writeFile(path.join(outDir, "sw.js"), source.replace("__BUILD_ID__", buildId));
		},
	};
}

export default defineConfig({
	root: import.meta.dirname,
	base: "./",
	plugins: [react(), devFixturesPlugin(), swBuildIdPlugin()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
