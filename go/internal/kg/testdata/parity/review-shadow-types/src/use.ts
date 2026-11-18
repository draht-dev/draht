import { Logger, log, register } from "./lib";

export function create(Logger: new () => unknown) {
	return new Logger();
}

export function pass(log: () => void) {
	register(log);
}

export function real() {
	register(log);
	return new Logger();
}

export function typed(
	cfg: {
		log(): void;
	},
) {
	return cfg;
}

export function ret(): {
	log(): void;
} {
	return null as never;
}

export const arrow = (
	cfg: {
		log(): void;
	},
) => cfg;

export const arrowRet = (n: number): { log(): void } | undefined => (n ? undefined : undefined);

export function dflt(
	cfg: Map<string, { log(): void }>,
	value = log(),
	cb: () => void = log,
) {
	return [cfg, value, cb];
}

export function pick(ready: boolean, value = ready ? 1 : log(), other: number = ready ? 2 : 3) {
	return value + other;
}

export class Holder {
	run(
		cfg: {
			log(): void;
		},
	): {
		log(): void;
	} {
		log();
		return cfg;
	}
}

export function typedParam(x: Logger) {
	return new Logger();
}

export function defaulted(n: number, cb = log, { a, b: c }: { a: number; b: number } = { a: 1, b: 2 }) {
	register(log);
	return new Logger();
}

export function nested(x: Logger | undefined, y?: Map<string, Logger>) {
	function inner(z: Logger, ...rest: Logger[]) {
		return z;
	}
	const arrow = (w: Logger | null, v = log) => w;
	register(log);
	return new Logger();
}

export function compared(flag = 1 < 2, log = flag) {
	return log();
}

export class Patterns {
	run({ cb = log, n: [m, ...rest] = [] }) {
		log();
		return [cb, m, rest];
	}
	renamed({ a: log }: { a: () => void }, b = 1 > 2, c: Map<string, Logger> = new Map()) {
		log();
		return new Logger();
	}
}

export const arrows = (flag = 1 < 2, register = flag, { x = log } = {}) => {
	log();
	return register;
};
