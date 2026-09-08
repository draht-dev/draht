#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const banner = {
	js: 'import { createRequire as __drahtCreateRequire } from "node:module"; const require = __drahtCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@draht/chord",
	"@draht/chord/bundler",
	"@draht/chord/context",
	"@draht/chord/delta",
	"@draht/chord/node",
	"@silvia-odwyer/photon-node",
	// Loaded through the @mariozechner/jiti external rewrite below.
	"@mariozechner/jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
	// @draht/rlm resolves its prompts/python/sandbox assets relative to its own
	// module location (import.meta.url); bundling it would break those lookups.
	"@draht/rlm",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^@mariozechner\/jiti$/ }, () => ({
			namespace: "lazy-jiti",
			path: "@mariozechner/jiti",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("@mariozechner/jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				// https-proxy-agent is a dependency of @draht/ai, not hoisted to the
				// repo root under bun's isolated node_modules layout.
				resolveDir: join(repoRoot, "packages", "ai"),
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { DRAHT_BUNDLED_NODE: "true" },
		external: ["@draht/chord", "@silvia-odwyer/photon-node", "@draht/rlm"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source imports @mariozechner/jiti directly, which would otherwise
		// pull its Babel transform into the bundle eagerly. lazyJitiPlugin
		// rewrites the import to a synchronous lazy require, so jiti (and Babel)
		// loads only when an extension is actually imported.
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		cli: join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
		"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
		"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
		"google-antigravity": join(aiDistDir, "auth", "oauth", "google-antigravity.js"),
		"google-gemini-cli": join(aiDistDir, "auth", "oauth", "google-gemini-cli.js"),
		"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
		"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
		"opencode-go": join(aiDistDir, "auth", "oauth", "opencode-go.js"),
		openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
		radius: join(aiDistDir, "auth", "oauth", "radius.js"),
		xai: join(aiDistDir, "auth", "oauth", "xai.js"),
	},
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}

validateExternalImports([mainResult.metafile, lazyResult.metafile]);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

const files = new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size;
const mib = outputBytes([mainResult.metafile, lazyResult.metafile]) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
