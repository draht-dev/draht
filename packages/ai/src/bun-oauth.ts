import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { antigravityOAuth } from "./auth/oauth/google-antigravity.ts";
import { geminiCliOAuth } from "./auth/oauth/google-gemini-cli.ts";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { opencodeGoOAuth } from "./auth/oauth/opencode-go.ts";
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		githubCopilot: () => githubCopilotOAuth,
		kimiCoding: () => kimiCodingOAuth,
		xai: () => xaiOAuth,
		radius: createRadiusOAuth,
		opencodeGo: () => opencodeGoOAuth,
		googleAntigravity: () => antigravityOAuth,
		googleGeminiCli: () => geminiCliOAuth,
	});
}
