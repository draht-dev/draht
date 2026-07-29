import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenCodeGoOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";

export function opencodeGoProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "opencode-go",
		name: "OpenCode Zen Go",
		auth: {
			apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]),
			// draht-only OAuth flow. Upstream deleted the runtime registry that used to make
			// this reachable, so the provider must declare it directly (mirrors xai.ts).
			oauth: lazyOAuth({
				name: "OpenCode Go",
				loginLabel: "Paste an OpenCode Zen API key",
				load: loadOpenCodeGoOAuth,
			}),
		},
		models: Object.values(OPENCODE_GO_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
