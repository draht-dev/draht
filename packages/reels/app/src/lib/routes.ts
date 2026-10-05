/** Hash-based routes: `#/`, `#/<repo>`, `#/<repo>/release/<tag>`, `#/<repo>/reel/<id>`, `#/<repo>/reel/<id>/deep`. Works on static hosts and GitHub Pages subpaths. */
export type Route =
	| { kind: "home" }
	| { kind: "repo"; repo: string }
	| { kind: "release"; repo: string; tag: string }
	| { kind: "reel"; repo: string; reelId: string; deep?: true };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "");
	const segments = path.split("/").filter((segment) => segment.length > 0);

	if (segments.length === 0) return { kind: "home" };

	const [repo, sub, idOrTag, maybeDeep] = segments;
	if (repo === undefined) return { kind: "home" };
	const decodedRepo = decodeURIComponent(repo);

	if (sub === "release" && idOrTag) return { kind: "release", repo: decodedRepo, tag: decodeURIComponent(idOrTag) };

	if (sub === "reel" && idOrTag) {
		const reelId = decodeURIComponent(idOrTag);
		return maybeDeep === "deep" ? { kind: "reel", repo: decodedRepo, reelId, deep: true } : { kind: "reel", repo: decodedRepo, reelId };
	}

	return { kind: "repo", repo: decodedRepo };
}

export function routeToHash(route: Route): string {
	switch (route.kind) {
		case "home":
			return "#/";
		case "repo":
			return `#/${encodeURIComponent(route.repo)}`;
		case "release":
			return `#/${encodeURIComponent(route.repo)}/release/${encodeURIComponent(route.tag)}`;
		case "reel":
			return `#/${encodeURIComponent(route.repo)}/reel/${encodeURIComponent(route.reelId)}${route.deep ? "/deep" : ""}`;
	}
}
