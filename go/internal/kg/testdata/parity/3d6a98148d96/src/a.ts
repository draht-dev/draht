export class Cell {
	getURL(): string { return ""; }
	getUrl(): string { return ""; }
	get value(): number { return 1; }
	set value(v: number) {}
	#value(): number { return 2; }
	$set(k: string): void {}
	set(k: string): void {}
	_a(): void {}
	__a(): void {}
	read(): number { return this.#value() + this.value; }
	write(): void { this.$set("k"); this.set("k"); }
}