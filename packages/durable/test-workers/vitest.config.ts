import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// vitest resolves `@vitest/*` from the project root, not from its own files, and this pool loads vitest through that
// resolver. draht has two vitest majors: an install that hoists the other one to the repository root (the release's
// `bun install --linker hoisted`) would hand this suite its `@vitest/expect`. Resolve them from the vitest that runs;
// a package it does not depend on (`@vitest/ui`, a coverage provider) falls through to the usual resolution.
const vitestRequire = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));

function fromRunningVitest(id: string): string | null {
	try {
		return vitestRequire.resolve(id);
	} catch {
		return null;
	}
}

// Runs in workerd: the Durable Object storage, alarms, and eviction are Cloudflare's own.
export default defineConfig({
	root: source("."),
	plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
	test: { include: ["*.test.ts"] },
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^(@vitest\/.+)$/, replacement: "$1", customResolver: fromRunningVitest },
			{ find: /^@draht\/durable$/, replacement: source("../src/index.ts") },
			{ find: /^@draht\/durable\/testing$/, replacement: source("../src/testing/index.ts") },
			{
				find: /^@draht\/durable\/storage\/sqlite\/cloudflare$/,
				replacement: source("../src/storage/sqlite/cloudflare.ts"),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
