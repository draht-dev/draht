import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const chordSrcIndex = fileURLToPath(new URL("../chord/src/index.ts", import.meta.url));
const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		// Resolve workspace packages to source so tests share one module instance with the
		// code under test. Without these, `@draht/*` resolves via package exports to dist/,
		// giving tests a second copy of module state — the provider registry the harness
		// tests mutate via `createModels()` / `models.setProvider()` would not be the one the
		// agent runtime reads. See packages/coding-agent/vitest.config.ts for the same fix.
		alias: [
			{ find: /^@draht\/chord$/, replacement: chordSrcIndex },
			{ find: /^@draht\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@draht\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@draht\/ai$/, replacement: aiSrcIndex },
			{ find: /^@draht\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@draht\/ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
		],
	},
});
