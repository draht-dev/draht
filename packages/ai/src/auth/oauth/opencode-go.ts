/** OpenCode Console device authorization, shared by Zen and Go. */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const CONSOLE_URL = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";
const REQUEST_TIMEOUT_MS = 30_000;
const SIGN_IN_MESSAGE = "Sign in with OpenCode Console again to continue.";

type Device = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
};
type Token = { access: string; refresh: string; expires: number; orgId?: string };
type Organization = { id: string; name: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function accessToken(value: unknown): value is string {
	return typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
}

function timerSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value * 1000 <= 2_147_483_647;
}

function organizationId(value: unknown): value is string {
	return nonempty(value) && !/[\r\n]/.test(value);
}

async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
	signal.throwIfAborted();
	return fetch(`${CONSOLE_URL}${path}`, {
		...init,
		headers: { Accept: "application/json", ...init.headers },
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
}

function post(path: string, body: Record<string, string | boolean>, signal: AbortSignal): Promise<Response> {
	return request(
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		signal,
	);
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`Invalid OpenCode ${operation} response (HTTP ${response.status})`);
	}
}

async function successfulJson(response: Response, operation: string): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`OpenCode ${operation} failed (HTTP ${response.status})`);
	}
	return responseJson(response, operation);
}

function parseDevice(raw: unknown): Device {
	const data = record(raw);
	if (
		!data ||
		!nonempty(data.device_code) ||
		!nonempty(data.user_code) ||
		!nonempty(data.verification_uri_complete) ||
		!timerSeconds(data.expires_in) ||
		!timerSeconds(data.interval)
	) {
		throw new Error("Invalid OpenCode device authorization response");
	}
	let url: URL;
	try {
		url = new URL(data.verification_uri_complete, `${CONSOLE_URL}/`);
		if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid URL");
	} catch {
		throw new Error("Invalid OpenCode device verification URL");
	}
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: url.href,
		expiresIn: data.expires_in,
		interval: data.interval,
	};
}

function parseToken(raw: unknown): Token {
	const data = record(raw);
	if (
		!data ||
		!accessToken(data.access_token) ||
		!nonempty(data.refresh_token) ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0 ||
		(data.org_id !== undefined && data.org_id !== null && !organizationId(data.org_id))
	) {
		throw new Error("Invalid OpenCode token response");
	}
	const expires = Date.now() + data.expires_in * 1000;
	// Token validity is a stored timestamp, not a JavaScript timer duration.
	if (!Number.isFinite(expires) || expires > Number.MAX_SAFE_INTEGER) {
		throw new Error("Invalid OpenCode token response");
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires,
		orgId: typeof data.org_id === "string" ? data.org_id : undefined,
	};
}

async function accountCredential(token: Token, signal: AbortSignal): Promise<OAuthCredential> {
	const init = { headers: { Authorization: `Bearer ${token.access}` } };
	const [rawUser, rawOrgs] = await Promise.all([
		request("/api/user", init, signal).then((response) => successfulJson(response, "account lookup")),
		request("/api/orgs", init, signal).then((response) => successfulJson(response, "organization lookup")),
	]);
	signal.throwIfAborted();
	const user = record(rawUser);
	if (!user || !nonempty(user.id) || !nonempty(user.email)) throw new Error("Invalid OpenCode account response");
	if (!Array.isArray(rawOrgs)) throw new Error("Invalid OpenCode organization response");
	const orgs: Organization[] = rawOrgs.map((raw: unknown) => {
		const org = record(raw);
		if (!org || !organizationId(org.id) || !nonempty(org.name))
			throw new Error("Invalid OpenCode organization response");
		return { id: org.id, name: org.name };
	});
	const org =
		token.orgId === undefined
			? orgs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
			: orgs.find((item) => item.id === token.orgId);
	if (token.orgId !== undefined && !org) throw new Error("OpenCode organization not found for the authorized account");
	return {
		type: "oauth",
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		opencodeConsole: true,
		accountId: user.id,
		email: user.email,
		orgId: org?.id,
		orgName: org?.name,
	};
}

async function loginOpenCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { signal } = interaction;
	const response = await post("/auth/device/code", { client_id: CLIENT_ID, supports_org_scope: true }, signal);
	const device = parseDevice(await successfulJson(response, "device authorization"));
	signal.throwIfAborted();
	interaction.notify({
		type: "auth_url",
		url: device.verificationUri,
		instructions: `Enter code: ${device.userCode}`,
	});
	const deadline = Date.now() + device.expiresIn * 1000;
	const token = await pollOAuthDeviceCodeFlow<Token>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expiresIn,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { status: "failed", message: "OpenCode device authorization expired" };
			const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]);
			const result = await post(
				"/auth/device/token",
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: device.deviceCode,
					client_id: CLIENT_ID,
				},
				pollSignal,
			);
			const raw = await responseJson(result, "device token");
			const error = record(raw)?.error;
			if (result.status === 400 || result.ok) {
				if (error === "authorization_pending") return { status: "pending" };
				if (error === "slow_down") return { status: "slow_down" };
				if (error === "access_denied") return { status: "failed", message: "OpenCode authorization denied" };
				if (error === "expired_token")
					return { status: "failed", message: "OpenCode device authorization expired" };
			}
			if (!result.ok || error !== undefined)
				return { status: "failed", message: `OpenCode device authorization failed (HTTP ${result.status})` };
			return { status: "complete", value: parseToken(raw) };
		},
	});
	return accountCredential(token, signal);
}

async function refreshOpenCode(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	signal.throwIfAborted();
	if (credential.opencodeConsole !== true || !nonempty(credential.refresh)) throw new Error(SIGN_IN_MESSAGE);
	const response = await post(
		"/auth/device/token",
		{
			grant_type: "refresh_token",
			refresh_token: credential.refresh,
			client_id: CLIENT_ID,
		},
		signal,
	);
	const raw = await responseJson(response, "refresh token");
	if (response.status === 400 && record(raw)?.error === "invalid_grant") throw new Error(SIGN_IN_MESSAGE);
	if (!response.ok) throw new Error(`OpenCode token refresh failed (HTTP ${response.status})`);
	const token = parseToken(raw);
	signal.throwIfAborted();
	return {
		...credential,
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		...(token.orgId === undefined
			? {}
			: {
					orgId: token.orgId,
					orgName: token.orgId === credential.orgId ? credential.orgName : token.orgId,
				}),
	};
}

function consoleOAuth(name: string, isSubscription?: boolean): OAuthAuth {
	return {
		name,
		isSubscription,
		loginLabel: "Sign in with OpenCode Console",
		login: loginOpenCode,
		refresh: refreshOpenCode,
		async toAuth(credential) {
			if (!accessToken(credential.access)) throw new Error("Invalid stored OpenCode access token");
			const orgId = credential.orgId;
			if (orgId !== undefined && !organizationId(orgId)) throw new Error("Invalid stored OpenCode organization");
			return {
				apiKey: credential.access,
				...(orgId === undefined ? {} : { headers: { "x-opencode-org-id": orgId } }),
			};
		},
	};
}

export const opencodeGoOAuth = consoleOAuth("OpenCode Go", true);
export const opencodeOAuth = consoleOAuth("OpenCode Zen");
