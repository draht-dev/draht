// Fixture plugin (slice 7c): the server facet, serving `Index` with the same label.

import { constant, defineFacet } from "@draht/chord";
import { Index } from "../contracts/contract.ts";
import { label } from "./label.ts";

export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
