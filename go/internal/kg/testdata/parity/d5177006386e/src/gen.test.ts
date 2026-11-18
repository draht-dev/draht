import { real } from "./real.js";
const FIXTURE = `
import { heavy } from "./heavy.js";
heavy();
export * from "./heavy.js";
`;
const SNIPPET = "const m = require('./heavy.js');";
const LAZY = "import(\"./heavy.js\")";
export function check() { return real() + FIXTURE + SNIPPET + LAZY; }