import { fa, fb } from "./a.js";
import { fd, fb as other } from "./c.js";
export function useAll() { return [fa(), fb(), fd(), other()]; }