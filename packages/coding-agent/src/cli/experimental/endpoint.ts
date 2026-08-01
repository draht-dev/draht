import { posix } from "node:path";

export interface UnixEndpoint {
	readonly transport: "unix";
	readonly path: string;
}

export type ExperimentalEndpoint = UnixEndpoint;

export function parseExperimentalEndpoint(
	value: string,
	option: "--listen" | "--connect",
): { endpoint?: ExperimentalEndpoint; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} endpoint "${value}"` };
	}
	if (url.protocol !== "unix:") {
		return { error: `Unsupported ${option} transport "${url.protocol}"` };
	}
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix endpoint must not include an authority" };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid ${option} endpoint "${value}"` };
	}
	if (!posix.isAbsolute(path)) {
		return { error: "Unix endpoint requires an absolute path" };
	}
	return { endpoint: { transport: "unix", path } };
}
