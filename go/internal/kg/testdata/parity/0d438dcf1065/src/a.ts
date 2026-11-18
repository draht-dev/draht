export function stream() { return 1; }
export function wrap(make: () => number) {
	const stream = make();
	return stream;
}
export function open(stream: () => number) { return stream(); }
export function real() { return stream(); }
