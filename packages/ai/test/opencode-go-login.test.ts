import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { opencodeGoOAuth } from "../src/auth/oauth/opencode-go.ts";
import type { AuthEvent, OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";

const CONSOLE = "https://opencode.ai/console";
const NOW = new Date("2026-10-19T12:00:00Z").getTime();
const device = {
	device_code: "test-device",
	user_code: "ABCD-EFGH",
	verification_uri_complete: "/console/auth/device?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 2,
};
const token = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600, org_id: "org-b" };
const orgs = [
	{ id: "org-a", name: "Alpha" },
	{ id: "org-b", name: "Beta" },
];
function interaction(signal = new AbortController().signal): ProviderAuthInteraction & { events: AuthEvent[] } {
	const events: AuthEvent[] = [];
	return { signal, events, notify: (event) => events.push(event), prompt: vi.fn(async () => "unused") };
}
function network(options: { device?: unknown; token?: unknown; orgs?: unknown; tokenStatus?: number } = {}) {
	const mock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
		const url = String(input);
		if (url === `${CONSOLE}/auth/device/code`) return Response.json(options.device ?? device);
		if (url === `${CONSOLE}/auth/device/token`)
			return Response.json(options.token ?? token, { status: options.tokenStatus ?? 200 });
		if (url === `${CONSOLE}/api/user`) return Response.json({ id: "user-test", email: "test@example.com" });
		if (url === `${CONSOLE}/api/orgs`) return Response.json(options.orgs ?? orgs);
		throw new Error(`Unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}
async function login(ctx = interaction()) {
	const [result] = await Promise.all([opencodeGoOAuth.login(ctx), vi.advanceTimersByTimeAsync(2000)]);
	return result;
}
function credential(): OAuthCredential {
	return {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		opencodeConsole: true,
		orgId: "org-b",
		orgName: "Beta",
		accountId: "user-test",
	};
}

describe("OpenCode Console browser login", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	it.each([opencodeGoProvider, opencodeProvider])(
		"advertises browser login and preserves manual API keys (%#)",
		async (factory) => {
			const provider = factory();
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with OpenCode Console");
			const ctx = interaction();
			vi.mocked(ctx.prompt).mockResolvedValue("service-account-key");
			await expect(provider.auth.apiKey?.login?.(ctx)).resolves.toEqual({
				type: "api_key",
				key: "service-account-key",
			});
		},
	);
	it("uses browser authorization, selected organization, and expiring credentials", async () => {
		const fetch = network();
		const ctx = interaction();
		const result = await login(ctx);
		expect(ctx.prompt).not.toHaveBeenCalled();
		expect(ctx.events).toContainEqual({
			type: "auth_url",
			url: "https://opencode.ai/console/auth/device?user_code=ABCD-EFGH",
			instructions: "Enter code: ABCD-EFGH",
		});
		expect(result).toMatchObject({
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: NOW + 2000 + 3600_000,
			opencodeConsole: true,
			orgId: "org-b",
			orgName: "Beta",
			accountId: "user-test",
		});
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
			client_id: "opencode-cli",
			supports_org_scope: true,
		});
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
			client_id: "opencode-cli",
			device_code: "test-device",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		await expect(opencodeGoOAuth.toAuth(result)).resolves.toEqual({
			apiKey: "test-access",
			headers: { "x-opencode-org-id": "org-b" },
		});
		expect(fetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
	});
	it("handles pending and slow_down without polling early", async () => {
		const fetch = network();
		fetch
			.mockResolvedValueOnce(Response.json(device))
			.mockResolvedValueOnce(Response.json({ error: "authorization_pending" }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ error: "slow_down" }, { status: 400 }));
		const result = opencodeGoOAuth.login(interaction());
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(6999);
		expect(fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toMatchObject({ access: "test-access" });
	});
	it("uses upstream's sorted organization fallback for unscoped tokens", async () => {
		network({ token: { ...token, org_id: null }, orgs: [orgs[1], orgs[0]] });
		await expect(login()).resolves.toMatchObject({ orgId: "org-a", orgName: "Alpha" });
	});
	it("rejects an unavailable selected organization", async () => {
		network({ orgs: [orgs[0]] });
		const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(/organization not found/i);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});
	it.each(["access_denied", "expired_token"])("stops on %s", async (error) => {
		network({ token: { error, error_description: "sensitive" }, tokenStatus: 400 });
		const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(
			error === "access_denied" ? /denied/i : /expired/i,
		);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});
	it.each([
		{ ...device, verification_uri_complete: "file:///tmp/executable" },
		{ ...device, expires_in: 0 },
		{ ...device, interval: -1 },
		{ ...device, device_code: "" },
	])("rejects invalid device data before prompting (%#)", async (response) => {
		const fetch = network({ device: response });
		const ctx = interaction();
		await expect(opencodeGoOAuth.login(ctx)).rejects.toThrow(/invalid/i);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(ctx.events).toEqual([]);
	});
	it("expires a pending device grant", async () => {
		const fetch = network({
			device: { ...device, expires_in: 3 },
			token: { error: "authorization_pending" },
			tokenStatus: 400,
		});
		const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(/timed out|expired/i);
		await vi.advanceTimersByTimeAsync(3000);
		await assertion;
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("cancels a polling wait", async () => {
		const fetch = network();
		const controller = new AbortController();
		const assertion = expect(opencodeGoOAuth.login(interaction(controller.signal))).rejects.toThrow(/cancel|abort/i);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await assertion;
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...token, access_token: "" },
		{ ...token, refresh_token: "" },
		{ ...token, expires_in: -1 },
		{ ...token, org_id: 42 },
	])("rejects invalid token data (%#)", async (response) => {
		network({ token: response });
		const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(/invalid/i);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});
	it.each(["test-access\r\ninjected", "test-access\u0000", "test-access\u0100"])(
		"rejects unsafe access tokens before native header errors can expose them (%#)",
		async (access) => {
			const fetch = network({ token: { ...token, access_token: access } });
			const respond = fetch.getMockImplementation();
			if (!respond) throw new Error("Missing network fixture");
			fetch.mockImplementation(async (input, init) => {
				new Request(input, init);
				return respond(input, init);
			});
			const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(
				"Invalid OpenCode token response",
			);
			await Promise.all([assertion, vi.advanceTimersByTimeAsync(2000)]);
			expect(fetch).toHaveBeenCalledTimes(2);
			await expect(opencodeGoOAuth.refresh(credential(), new AbortController().signal)).rejects.toThrow(
				"Invalid OpenCode token response",
			);
			await expect(opencodeGoOAuth.toAuth({ ...credential(), access })).rejects.toThrow(
				"Invalid stored OpenCode access token",
			);
		},
	);
	it("rotates refresh tokens without account discovery", async () => {
		const fetch = network();
		await expect(opencodeGoOAuth.refresh(credential(), new AbortController().signal)).resolves.toMatchObject({
			access: "test-access",
			refresh: "test-refresh",
			expires: NOW + 3600_000,
			orgId: "org-b",
			orgName: "Beta",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
			grant_type: "refresh_token",
			refresh_token: "old-refresh",
			client_id: "opencode-cli",
		});
	});
	it("accepts token lifetimes longer than the JavaScript timer limit during login and refresh", async () => {
		const expiresIn = 30 * 24 * 60 * 60;
		network({ token: { ...token, expires_in: expiresIn } });
		const result = await login();
		expect(result.expires).toBe(NOW + 2000 + expiresIn * 1000);
		const refreshed = await opencodeGoOAuth.refresh(result, new AbortController().signal);
		expect(refreshed.expires).toBe(NOW + 2000 + expiresIn * 1000);
	});
	it.each([0, -1, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, "3600"])(
		"rejects token lifetimes that cannot produce a valid expiry timestamp (%#)",
		async (expiresIn) => {
			network({ token: { ...token, expires_in: expiresIn } });
			await expect(opencodeGoOAuth.refresh(credential(), new AbortController().signal)).rejects.toThrow(
				"Invalid OpenCode token response",
			);
		},
	);
	it("updates changed organization scope on refresh", async () => {
		network({ token: { ...token, org_id: "org-c" } });
		await expect(opencodeGoOAuth.refresh(credential(), new AbortController().signal)).resolves.toMatchObject({
			orgId: "org-c",
			orgName: "org-c",
		});
	});
	it("requires re-login after refresh revocation", async () => {
		network({ token: { error: "invalid_grant", error_description: "sensitive" }, tokenStatus: 400 });
		await expect(opencodeGoOAuth.refresh(credential(), new AbortController().signal)).rejects.toThrow(
			/sign in.*OpenCode Console/i,
		);
	});
	it("does not send old pasted keys to the refresh endpoint", async () => {
		const fetch = network();
		await expect(
			opencodeGoOAuth.refresh(
				{ type: "oauth", access: "api-key", refresh: "api-key", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow(/sign in.*OpenCode Console/i);
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([opencodeGoProvider, opencodeProvider])(
		"persists login and serializes refresh through Models (%#)",
		async (factory) => {
			const fetch = network();
			const credentials = new InMemoryCredentialStore();
			const models = createModels({ credentials });
			const provider = factory();
			models.setProvider(provider);
			const ctx = interaction();
			const result = models.login(provider.id, "oauth", ctx);
			await vi.waitFor(() => expect(ctx.events).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(2000);
			const stored = await result;
			expect(await credentials.read(provider.id)).toEqual(stored);
			await credentials.modify(provider.id, async () => ({ ...stored, expires: 0 }));
			fetch.mockClear();
			fetch.mockResolvedValueOnce(
				Response.json({ ...token, access_token: "rotated-access", refresh_token: "rotated-refresh" }),
			);
			const auth = await Promise.all([models.getAuth(provider.id), models.getAuth(provider.id)]);
			expect(auth[0]?.auth).toEqual(auth[1]?.auth);
			expect(auth[0]?.auth).toEqual({ apiKey: "rotated-access", headers: { "x-opencode-org-id": "org-b" } });
			expect(auth[0]?.source).toBe("OAuth");
			expect(await credentials.list()).toEqual([{ providerId: provider.id, type: "oauth" }]);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await credentials.read(provider.id)).toMatchObject({
				access: "rotated-access",
				refresh: "rotated-refresh",
			});
		},
	);
	it.each(["cancel", "deny"])("preserves the stored credential when browser login fails (%s)", async (failure) => {
		network({ token: { error: "access_denied" }, tokenStatus: 400 });
		const credentials = new InMemoryCredentialStore();
		const original = credential();
		await credentials.modify("opencode-go", async () => original);
		const models = createModels({ credentials });
		models.setProvider(opencodeGoProvider());
		const controller = new AbortController();
		const ctx = interaction(controller.signal);
		const result = models.login("opencode-go", "oauth", ctx);
		const assertion = expect(result).rejects.toThrow(/abort|cancel|denied/i);
		await vi.waitFor(() => expect(ctx.events).toHaveLength(1));
		if (failure === "cancel") controller.abort();
		else await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(await credentials.read("opencode-go")).toEqual(original);
	});
	it("preserves revoked credentials and does not fall back to an ambient API key", async () => {
		const fetch = network({ token: { error: "invalid_grant", error_description: "sensitive" }, tokenStatus: 400 });
		const credentials = new InMemoryCredentialStore();
		const original = credential();
		await credentials.modify("opencode-go", async () => original);
		const env = vi.fn(async () => "ambient-key");
		const models = createModels({ credentials, authContext: { env, fileExists: async () => false } });
		models.setProvider(opencodeGoProvider());
		await expect(models.getAuth("opencode-go")).rejects.toThrow(/Sign in with OpenCode Console/);
		expect(await credentials.read("opencode-go")).toEqual(original);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(env).not.toHaveBeenCalled();
	});
	it("aborts an in-flight device request", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			async (_input: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const result = opencodeGoOAuth.login(interaction(controller.signal));
		const assertion = expect(result).rejects.toThrow(/abort/i);
		controller.abort();
		await assertion;
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not echo unexpected server errors or token response bodies", async () => {
		network({ token: { error: "sensitive-provider-diagnostic", access_token: "secret-access" }, tokenStatus: 500 });
		const assertion = expect(opencodeGoOAuth.login(interaction())).rejects.toThrow(
			"OpenCode device authorization failed (HTTP 500)",
		);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});
});
