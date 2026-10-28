import { useCallback, useEffect, useState } from "react";
import { parseHash, type Route, routeToHash } from "../lib/routes.js";

export interface NavigateOptions {
	/**
	 * Replace the current history entry instead of pushing a new one. Used
	 * while scrolling within the feed, so Back from a reel returns to the
	 * profile it was opened from rather than walking backwards through every
	 * reel the user scrolled past.
	 */
	replace?: boolean;
}

export function useHashRoute(): [Route, (route: Route, options?: NavigateOptions) => void] {
	const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

	useEffect(() => {
		const handler = () => setRoute(parseHash(window.location.hash));
		window.addEventListener("hashchange", handler);
		return () => window.removeEventListener("hashchange", handler);
	}, []);

	const navigate = useCallback((next: Route, options?: NavigateOptions) => {
		const hash = routeToHash(next);
		if (options?.replace) {
			// history.replaceState does not fire `hashchange`, so the local
			// route state is updated directly here.
			history.replaceState(history.state, "", hash);
			setRoute(next);
		} else {
			window.location.hash = hash;
		}
	}, []);

	return [route, navigate];
}
