// The bad-web plugin's web facet: a Node builtin has no place in a browser build (refused at build).

import { join } from "node:path";
import { defineFacet } from "@draht/chord";

export default defineFacet(() => {
	console.log(join("a", "b"));
});
