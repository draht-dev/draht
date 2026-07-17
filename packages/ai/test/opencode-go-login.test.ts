import { describe, expect, it } from "vitest";
import { loginOpenCodeGo, opencodeGoOAuth, refreshOpenCodeGoToken } from "../src/auth/oauth/opencode-go.js";
import type { AuthEvent, AuthInteraction } from "../src/auth/types.ts";

function interaction(answer: string): AuthInteraction & { events: AuthEvent[] } {
	const events: AuthEvent[] = [];
	return {
		events,
		notify: (event) => events.push(event),
		prompt: async () => answer,
	};
}

describe("OpenCode Go login", () => {
	it("opens the OpenCode Zen dashboard and stores the pasted key as access", async () => {
		const ctx = interaction("  sk-opencode-test  ");
		const credential = await loginOpenCodeGo(ctx);

		const authEvent = ctx.events.find((event) => event.type === "auth_url");
		expect(authEvent).toMatchObject({ url: "https://opencode.ai/zen" });
		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("sk-opencode-test");
		expect(credential.refresh).toBe("sk-opencode-test");
		expect(credential.expires).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("rejects an empty paste", async () => {
		await expect(loginOpenCodeGo(interaction("   "))).rejects.toThrow(/missing opencode api key/i);
	});

	it("refresh is a no-op (API keys do not expire)", async () => {
		const original = { type: "oauth", access: "key", refresh: "key", expires: 0 } as const;
		const refreshed = await refreshOpenCodeGoToken(original);
		expect(refreshed.access).toBe("key");
		expect(refreshed.expires).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("exposes an OAuthAuth whose toAuth returns the key as apiKey", async () => {
		expect(opencodeGoOAuth.name).toBe("OpenCode Go");
		await expect(opencodeGoOAuth.toAuth({ type: "oauth", access: "k", refresh: "k", expires: 0 })).resolves.toEqual({
			apiKey: "k",
		});
	});
});
