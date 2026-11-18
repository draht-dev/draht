import { helperA } from "./helper.js";
export function globs(files: string[]) {
	return files.filter((f) => f.startsWith("src/*"));
}
export function afterGlob() { return helperA(); }
/* a real comment */
export function quote(s: string) {
	return "`" + s;
}
export function afterTick() { return helperA(); }
export function escapes(s: string) {
	return s.replace(/[`*_]/g, "");
}
export function afterRegex() { return helperA(); }
export function nested(x: string) {
	return `[${x}] ${wrap(`<${helperA()}>`)}`;
}
export function wrap(s: string) { return s; }