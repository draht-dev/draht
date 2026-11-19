import { snapshot } from "./util.js";
export class Parser {
	#time(message: string): void { snapshot(); }
	run(): void { this.#time("x"); }
	#snapshot(): number {
		return 1;
	}
	read(): number { return this.#snapshot(); }
	static #make(): Parser { return new Parser(); }
}