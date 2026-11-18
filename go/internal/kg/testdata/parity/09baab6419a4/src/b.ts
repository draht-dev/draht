import { publicHelper, Agent, Logger } from "./a.js";

export function start(agent: Agent, make: () => number) {
	make();
	agent.runAll([]);
	const inner = () => publicHelper();
	function nested() { return inner(); }
	return nested;
}

export function log(x: { record(m: string): void; push(m: string): void }) {
	x.record("a");
	x.push("b");
}
