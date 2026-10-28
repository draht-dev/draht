import path from "node:path";

/**
 * Resolves `requestPath` against `baseDir` and returns the resolved path
 * only if it stays inside `baseDir`; otherwise `undefined`. Used to serve
 * files for an attacker-controlled request path without a `../` segment
 * (however encoded) escaping the intended directory.
 */
export function safeJoin(baseDir: string, requestPath: string): string | undefined {
	const resolvedBase = path.resolve(baseDir);
	const resolved = path.resolve(resolvedBase, `.${requestPath}`);
	if (resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep)) return resolved;
	return undefined;
}
