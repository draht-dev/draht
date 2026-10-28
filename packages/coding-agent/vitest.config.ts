import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcApi = fileURLToPath(new URL("../ai/src/api", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const aiSrcUtils = fileURLToPath(new URL("../ai/src/utils", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const chordSrcIndex = fileURLToPath(new URL("../chord/src/index.ts", import.meta.url));
const chordSrcContext = fileURLToPath(new URL("../chord/src/context/index.ts", import.meta.url));
const chordSrcDelta = fileURLToPath(new URL("../chord/src/delta/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const mcpSrcIndex = fileURLToPath(new URL("../mcp/src/index.ts", import.meta.url));
const mcpSrcOAuth = fileURLToPath(new URL("../mcp/src/oauth/index.ts", import.meta.url));
const mcpSrcTesting = fileURLToPath(new URL("../mcp/src/testing/index.ts", import.meta.url));
const rlmSrcIndex = fileURLToPath(new URL("../rlm/src/index.ts", import.meta.url));
const routerSrcIndex = fileURLToPath(new URL("../router/src/index.ts", import.meta.url));
const knowledgeSrcIndex = fileURLToPath(new URL("../knowledge/src/index.ts", import.meta.url));
const codemodeSrcIndex = fileURLToPath(new URL("../codemode/src/index.ts", import.meta.url));
const codemodeSrcDeclarations = fileURLToPath(new URL("../codemode/src/declarations.ts", import.meta.url));
const codemodeSrcSource = fileURLToPath(new URL("../codemode/src/source.ts", import.meta.url));

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
		globalSetup: ["./test/setup/emitted-build-run.ts"],
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
			{ find: /^@draht\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@draht\/ai$/, replacement: aiSrcIndex },
			{ find: /^@draht\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@draht\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@draht\/ai\/api\/(.+)$/, replacement: `${aiSrcApi}/$1.ts` },
			{ find: /^@draht\/ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@draht\/ai\/utils\/(.+)$/, replacement: `${aiSrcUtils}/$1.ts` },
			{ find: /^@draht\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@draht\/chord$/, replacement: chordSrcIndex },
			{ find: /^@draht\/chord\/context$/, replacement: chordSrcContext },
			{ find: /^@draht\/chord\/delta$/, replacement: chordSrcDelta },
			{ find: /^@draht\/tui$/, replacement: tuiSrcIndex },
			{ find: /^@draht\/mcp$/, replacement: mcpSrcIndex },
			{ find: /^@draht\/mcp\/oauth$/, replacement: mcpSrcOAuth },
			{ find: /^@draht\/mcp\/testing$/, replacement: mcpSrcTesting },
			{ find: /^@draht\/rlm$/, replacement: rlmSrcIndex },
			{ find: /^@draht\/router$/, replacement: routerSrcIndex },
			{ find: /^@draht\/knowledge$/, replacement: knowledgeSrcIndex },
			{ find: /^@draht\/codemode$/, replacement: codemodeSrcIndex },
			{ find: /^@draht\/codemode\/declarations$/, replacement: codemodeSrcDeclarations },
			{ find: /^@draht\/codemode\/source$/, replacement: codemodeSrcSource },
		],
	},
});
