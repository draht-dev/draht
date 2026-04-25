import { describe, expect, it } from "vitest";
import { loginOpenCodeGo, opencodeGoOAuthProvider, refreshOpenCodeGoToken } from "../src/utils/oauth/opencode-go.js";

describe("OpenCode Go login", () => {
	it("opens the OpenCode Zen dashboard and stores the pasted key as access", async () => {
		let authUrl = "";
		const credentials = await loginOpenCodeGo({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "  sk-opencode-test  ",
		});

		expect(authUrl).toBe("https://opencode.ai/zen");
		expect(credentials.access).toBe("sk-opencode-test");
		expect(credentials.refresh).toBe("sk-opencode-test");
		expect(credentials.expires).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("rejects an empty paste", async () => {
		await expect(
			loginOpenCodeGo({
				onAuth: () => {},
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow(/missing opencode api key/i);
	});

	it("refresh is a no-op (API keys do not expire)", async () => {
		const original = { access: "key", refresh: "key", expires: 0 };
		const refreshed = await refreshOpenCodeGoToken(original);
		expect(refreshed.access).toBe("key");
		expect(refreshed.expires).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("provider exposes id, name, and getApiKey", () => {
		expect(opencodeGoOAuthProvider.id).toBe("opencode-go");
		expect(opencodeGoOAuthProvider.name).toBe("OpenCode Go");
		expect(opencodeGoOAuthProvider.getApiKey({ access: "k", refresh: "k", expires: 0 })).toBe("k");
	});
});
