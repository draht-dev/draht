// The old plugin's server facet; the example deletes the plugin's directory.

import { constant, defineFacet } from "@draht/chord";
import { labelOf } from "../contracts/contract.ts";

export default defineFacet((host) => host.serve(labelOf("old"), () => ({ text: constant("old on the server") })));
