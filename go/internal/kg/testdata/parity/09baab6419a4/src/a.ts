export interface Base<T> { id: T }
export interface Named { name: string }
export interface Item<T extends string = string> extends Base<T>, Named {}

export class Agent {
	private pool: Pool = new Pool();
	constructor(private readonly log: Logger) {}
	async runAll<
		T extends string,
	>(items: T[]): Promise<void> {
		this.pool.acquire();
		this.log.record(items.join());
	}
	stop = (): void => { this.pool.release(); };
}

export class Pool {
	acquire(): void {}
	release(): void {}
}

export class Logger {
	record(msg: string): void {}
	push(x: string): void {}
}

const make = <T,>(x: T): T => x;
export const Legacy = class { run() {} };
function helper() { return 1; }
export { helper as publicHelper };
