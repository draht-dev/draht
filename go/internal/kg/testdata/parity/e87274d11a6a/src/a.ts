export class Cell {
	write(): void { this.$set("k"); this.set("k"); }
	read(): number { return this.#value() + this.value; }
	__a(): void {}
	_a(): void {}
	set(k: string): void {}
	$set(k: string): void {}
	#value(): number { return 2; }
	set value(v: number) {}
	get value(): number { return 1; }
	getUrl(): string { return ""; }
	getURL(): string { return ""; }
}