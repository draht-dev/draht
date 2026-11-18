import { load, save } from "./config.js";
export interface Persist {
	save(): number;
}
export type Loader = {
	load(): object;
};
export class Store {
	load(): object {
		return {};
	}
	flush() { return save(); }
}