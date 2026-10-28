import type { Mermaid } from "mermaid";

let mermaidPromise: Promise<Mermaid> | undefined;

/** Lazily loads and initializes mermaid once; subsequent calls reuse the same instance. */
export function loadMermaid(): Promise<Mermaid> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((module) => {
			const mermaid = module.default;
			mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
			return mermaid;
		});
	}
	return mermaidPromise;
}
