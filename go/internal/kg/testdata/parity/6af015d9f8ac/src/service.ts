import { helper } from "./base.js";
export class Service {
	private ready = false;
	constructor(private readonly name: string) {
		helper(name);
		this.init();
	}
	init(): void { this.ready = true; }
}
export function make() { return new Service("x"); }