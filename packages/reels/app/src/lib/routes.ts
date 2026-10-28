/**
 * Hash-based routes: `#/`, `#/<repo>`, `#/<repo>/release/<tag>`,
 * `#/<repo>/reel/<id>`, `#/<repo>/reel/<id>/deep`, and a reel played from
 * within a release playlist, `#/<repo>/release/<tag>/reel/<id>` (optionally
 * `/deep` too). Works on static hosts and GitHub Pages subpaths.
 */
export type Route =
	| { kind: "home" }
	| { kind: "repo"; repo: string }
	| { kind: "release"; repo: string; tag: string }
	| { kind: "reel"; repo: string; reelId: string; deep?: true; releaseTag?: string };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "");
	const segments = path.split("/").filter((segment) => segment.length > 0).map(decodeURIComponent);

	const [repo, sub, idOrTag] = segments;
	if (repo === undefined) return { kind: "home" };

	if (sub === "release" && idOrTag !== undefined) {
		const [, , , sub2, reelId, maybeDeep] = segments;
		if (sub2 === "reel" && reelId !== undefined) {
			return maybeDeep === "deep"
				? { kind: "reel", repo, reelId, releaseTag: idOrTag, deep: true }
				: { kind: "reel", repo, reelId, releaseTag: idOrTag };
		}
		return { kind: "release", repo, tag: idOrTag };
	}

	if (sub === "reel" && idOrTag !== undefined) {
		const maybeDeep = segments[3];
		return maybeDeep === "deep" ? { kind: "reel", repo, reelId: idOrTag, deep: true } : { kind: "reel", repo, reelId: idOrTag };
	}

	return { kind: "repo", repo };
}

export function routeToHash(route: Route): string {
	switch (route.kind) {
		case "home":
			return "#/";
		case "repo":
			return `#/${encodeURIComponent(route.repo)}`;
		case "release":
			return `#/${encodeURIComponent(route.repo)}/release/${encodeURIComponent(route.tag)}`;
		case "reel": {
			const base = route.releaseTag
				? `#/${encodeURIComponent(route.repo)}/release/${encodeURIComponent(route.releaseTag)}/reel/${encodeURIComponent(route.reelId)}`
				: `#/${encodeURIComponent(route.repo)}/reel/${encodeURIComponent(route.reelId)}`;
			return route.deep ? `${base}/deep` : base;
		}
	}
}
