/** Hash-based routes: `#/`, `#/<repo>`, `#/<repo>/reel/<id>`. Works on static hosts and GitHub Pages subpaths. */
export type Route =
	| { kind: "home" }
	| { kind: "repo"; repo: string }
	| { kind: "reel"; repo: string; reelId: string };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "");
	const segments = path.split("/").filter((segment) => segment.length > 0);

	if (segments.length === 0) return { kind: "home" };

	const [repo, maybeReel, reelId] = segments;
	if (repo === undefined) return { kind: "home" };
	if (maybeReel === "reel" && reelId) return { kind: "reel", repo: decodeURIComponent(repo), reelId: decodeURIComponent(reelId) };
	return { kind: "repo", repo: decodeURIComponent(repo) };
}

export function routeToHash(route: Route): string {
	switch (route.kind) {
		case "home":
			return "#/";
		case "repo":
			return `#/${encodeURIComponent(route.repo)}`;
		case "reel":
			return `#/${encodeURIComponent(route.repo)}/reel/${encodeURIComponent(route.reelId)}`;
	}
}
