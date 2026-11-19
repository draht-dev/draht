export class Lazy {
	load = () =>
		import("./registry.js");
	pick = (x: number) =>
		delete (this.cache[x]);
	handler =
		function (x: number) { return x; };
	later =
		async (x: number) => { return x; };
	kind = (x: unknown) =>
		typeof (x) === "number" ? 1 : 2;
	cache: Record<number, number> = {};
	run(): number {
		if (this.ok()) { return (1); }
		for (const x of [1]) { void x; }
		return (2);
	}
	ok(): boolean { return true; }
}