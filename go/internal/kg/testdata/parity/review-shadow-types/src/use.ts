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
