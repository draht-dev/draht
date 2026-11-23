// The notes plugin's worker facet: its label.

import { constant, defineFacet } from "@draht/chord";
import { labelOf } from "../contracts/contract.ts";
import { label } from "./label.ts";

export default defineFacet((host) =>
	host.serve(labelOf("notes"), () => ({ text: constant(`${label} on the worker`) })),
);
