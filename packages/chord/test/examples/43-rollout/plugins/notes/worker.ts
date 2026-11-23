// The notes plugin's worker facet.

import { constant, defineFacet } from "@draht/chord";
import { Label } from "./contract.ts";
import { label } from "./label.ts";

export default defineFacet((host) =>
	host.serve(Label, ({ id }) => ({ variant: "main", members: { text: constant(`${id}: ${label}`) } })),
);
