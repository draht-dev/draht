export function register(alpha: () => void, beta: () => void, gamma: () => void) {}
export function a1() {}
export function a2() {}
export function a3() {}
export function wire() {
	register(a1, a2, a3);
}