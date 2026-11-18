export class Registry {
	delete(id: string): boolean { return id.length > 0; }
	async catch(onRejected: () => void): Promise<void> {}
	return(value: number): number { return (value); }
	match(pattern: string): boolean { return this.delete(pattern); }
	select(): void {}
	use(): void {}
	clear(): void { this.delete("x"); }
}
export abstract class Shape {
	abstract delete(id: string): void;
}
export declare class Ambient {
	constructor(name: string);
	delete(id: string): boolean;
	get(id: string): string;
}