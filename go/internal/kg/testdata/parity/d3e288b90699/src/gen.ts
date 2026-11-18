import { render } from "./real.js";
const TEMPLATE = `
export function render() {
	return 0;
}
`;
export function build() {
	return render() + TEMPLATE;
}