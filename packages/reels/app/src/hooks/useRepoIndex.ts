import { useEffect, useState } from "react";
import type { RepoIndex } from "../../../src/contract.js";

export type RepoIndexState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; index: RepoIndex };

export function useRepoIndex(): RepoIndexState {
	const [state, setState] = useState<RepoIndexState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;

		fetch("./repos.json")
			.then((response) => {
				if (!response.ok) throw new Error(`repos.json: HTTP ${response.status}`);
				return response.json() as Promise<RepoIndex>;
			})
			.then((index) => {
				if (!cancelled) setState({ status: "ready", index });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return state;
}
