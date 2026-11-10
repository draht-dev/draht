import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

/**
 * Registers OAuth flow loaders with literal dynamic imports, for Node bundles
 * that split at dynamic imports (esbuild `splitting`, Chord's worker base):
 * each flow lands in a chunk loaded on its first use, inside the bundle.
 * Without it, @draht/ai imports the flows through a variable specifier that
 * bundlers cannot follow, so a bundle loads them from @draht/ai's own files.
 * Browser bundles must not import this module (the flows are Node-only).
 */
export function registerLazyOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: async () => (await import("./auth/oauth/anthropic.ts")).anthropicOAuth,
		openaiCodex: async () => (await import("./auth/oauth/openai-codex.ts")).openaiCodexOAuth,
		openaiChatGPT: async () => (await import("./auth/oauth/openai-chatgpt.ts")).openaiChatGPTOAuth,
		githubCopilot: async () => (await import("./auth/oauth/github-copilot.ts")).githubCopilotOAuth,
		openrouter: async () => (await import("./auth/oauth/openrouter.ts")).openRouterOAuth,
		kimiCoding: async () => (await import("./auth/oauth/kimi-coding.ts")).kimiCodingOAuth,
		meta: async () => (await import("./auth/oauth/meta.ts")).metaOAuth,
		xai: async () => (await import("./auth/oauth/xai.ts")).xaiOAuth,
		radius: async (options) => (await import("./auth/oauth/radius.ts")).createRadiusOAuth(options),
		opencodeGo: async () => (await import("./auth/oauth/opencode-go.ts")).opencodeGoOAuth,
		opencode: async () => (await import("./auth/oauth/opencode-go.ts")).opencodeOAuth,
		googleAntigravity: async () => (await import("./auth/oauth/google-antigravity.ts")).antigravityOAuth,
		googleGeminiCli: async () => (await import("./auth/oauth/google-gemini-cli.ts")).geminiCliOAuth,
	});
}
