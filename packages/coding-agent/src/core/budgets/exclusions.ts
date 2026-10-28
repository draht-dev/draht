const LOCKFILES = new Set([
	"bun.lock",
	"bun.lockb",
	"cargo.lock",
	"composer.lock",
	"deno.lock",
	"flake.lock",
	"gemfile.lock",
	"go.sum",
	"go.work.sum",
	"gradle.lockfile",
	"mix.lock",
	"npm-shrinkwrap.json",
	"package-lock.json",
	"package.resolved",
	"packages.lock.json",
	"pdm.lock",
	"pipfile.lock",
	"pnpm-lock.yaml",
	"podfile.lock",
	"poetry.lock",
	"pubspec.lock",
	"uv.lock",
	"yarn.lock",
]);

const CREDENTIALS =
	/^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx))$/;

/**
 * Lockfiles and changelogs grow with routine work, and credential files must not be copied into the ledger's
 * snapshots, so budgets never read them.
 */
export function isAlwaysExcluded(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	return LOCKFILES.has(name) || name === "changelog.md" || CREDENTIALS.test(name);
}

export function parseExcludes(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Budget exclude must be an array of glob patterns");
	return value.map((pattern: unknown) => {
		if (typeof pattern !== "string" || !pattern.trim() || pattern.startsWith("!") || pattern.includes("\0")) {
			throw new Error(`Invalid budget exclude pattern: ${JSON.stringify(pattern)}`);
		}
		return pattern;
	});
}

function globSource(glob: string): string {
	let source = "";
	for (let index = 0; index < glob.length; ) {
		if (glob.startsWith("**/", index)) {
			source += "(?:.*/)?";
			index += 3;
		} else if (glob.startsWith("**", index)) {
			source += ".*";
			index += 2;
		} else {
			const character = glob[index++];
			if (character === "*") source += "[^/]*";
			else if (character === "?") source += "[^/]";
			else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return source;
}

/**
 * Compiles `exclude` patterns with .gitignore-style anchoring: a pattern without a slash matches a
 * name at any depth, a pattern with one is relative to the repository root, and a trailing slash
 * matches everything below a directory. Supports `*`, `?` and `**`.
 */
export function excludeMatcher(patterns: readonly string[]): (path: string) => boolean {
	const expressions = patterns.map((pattern) => {
		const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
		const anchored = pattern.replace(/\/+$/, "").includes("/");
		const below = pattern.endsWith("/") ? "/.*" : "(?:/.*)?";
		return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globSource(body)}${below}$`);
	});
	return (path) => expressions.some((expression) => expression.test(path));
}
