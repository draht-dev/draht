import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// test.sh raises this for the local release gate, where the git-backed
		// integration suites run 10x slower than on a sharded CI runner.
		testTimeout: Number(process.env.DRAHT_TEST_TIMEOUT_MS ?? 30000),
		// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
		env: { DRAHT_OFFLINE: "1" },
		unstubEnvs: true,
		setupFiles: ["./test/setup/restore-cwd.ts"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		// Resolve workspace packages to source so tests share one module instance with the
		// code under test. Without these, `@draht/*` resolves via package exports to dist/,
		// giving tests a second copy of module state — provider registries mutated through
		// `@draht/ai/compat` would not be the ones the runtime reads, and `vi.mock` of a
		// transitive dep (e.g. "openai") would not intercept the dist copy's imports.
		alias: [
			{ find: /^@draht\/ai$/, replacement: aiSrcIndex },
			{ find: /^@draht\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@draht\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@draht\/ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@draht\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@draht\/tui$/, replacement: tuiSrcIndex },
		],
	},
});
