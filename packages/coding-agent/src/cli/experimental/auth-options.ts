export type ClientAuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

export type ServerAuthInput = ClientAuthInput | { readonly type: "generated"; readonly writeTo: string };

export interface RawAuthOptions {
	readonly authToken?: string;
	readonly authTokenFile?: string;
	readonly writeAuthToken?: string;
}

export function parseAuthInput(
	options: RawAuthOptions,
	role: "combined" | "server",
): { auth?: ServerAuthInput; errors: string[] };
export function parseAuthInput(options: RawAuthOptions, role: "client"): { auth?: ClientAuthInput; errors: string[] };
export function parseAuthInput(
	options: RawAuthOptions,
	role: "combined" | "server" | "client",
): { auth?: ServerAuthInput; errors: string[] } {
	const configured = [options.authToken, options.authTokenFile, options.writeAuthToken].filter(
		(value): value is string => value !== undefined,
	);
	if (configured.length > 1) {
		return {
			errors: ["--auth-token, --auth-token-file, and --write-auth-token are mutually exclusive"],
		};
	}
	if (options.writeAuthToken !== undefined) {
		if (role === "client") {
			return { errors: ["--write-auth-token is only valid for combined or server mode"] };
		}
		return { auth: { type: "generated", writeTo: options.writeAuthToken }, errors: [] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}
