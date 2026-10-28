import { useState } from "react";
import type { RepoIndex } from "../../../src/contract.js";
import { initials } from "../lib/initials.js";

/**
 * `repo.poster` is relative to `repos.json`, which per the contract always
 * lives at the site root, so it is already a usable path with no rewriting.
 */
function RepoAvatar({ name, poster }: { name: string; poster: string | undefined }) {
	const [failed, setFailed] = useState(false);

	if (poster && !failed) {
		return <img src={poster} alt="" className="home-repo-avatar-image" onError={() => setFailed(true)} />;
	}

	return (
		<span className="home-repo-avatar" aria-hidden="true">
			{initials(name)}
		</span>
	);
}

function formatLatest(latest: string | undefined): string | undefined {
	if (!latest) return undefined;
	const date = new Date(latest);
	return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString();
}

export function Home({ index, onOpenRepo }: { index: RepoIndex; onOpenRepo: (repo: string) => void }) {
	return (
		<div className="home">
			<h1 className="home-title">Draht Reels</h1>
			<ul className="home-repo-list">
				{index.repos.map((repo) => {
					const latest = formatLatest(repo.latest);
					return (
						<li key={repo.name}>
							<button type="button" className="home-repo-item" onClick={() => onOpenRepo(repo.name)}>
								<RepoAvatar name={repo.name} poster={repo.poster} />
								<span className="home-repo-info">
									<span className="home-repo-name">{repo.name}</span>
									<span className="home-repo-meta">
										{repo.reelCount} reels{latest ? ` · updated ${latest}` : ""}
									</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
