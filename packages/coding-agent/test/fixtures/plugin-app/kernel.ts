/** Minimal session-side plugin lifecycle. The app owns every service and registry. */

export interface AppPlugin<Api> {
	id: string;
	setup(api: Api): void | Promise<void>;
}

export interface AppInstance<Api, Driver> {
	readonly driver: Driver;
	activate(): void | Promise<void>;
	api(owner: string): Api;
	close(): void;
}

export interface AppDefinition<Api, Driver> {
	id: string;
	create(): AppInstance<Api, Driver>;
	plugins: readonly AppPlugin<Api>[];
}

export function defineApp<Api, Driver>(definition: AppDefinition<Api, Driver>): AppDefinition<Api, Driver> {
	return definition;
}

export function definePlugin<Api>(plugin: AppPlugin<Api>): AppPlugin<Api> {
	return plugin;
}

export class TestAppRuntime<Api, Driver> {
	readonly definition: AppDefinition<Api, Driver>;
	readonly driver: Driver;
	private readonly instance: AppInstance<Api, Driver>;

	constructor(definition: AppDefinition<Api, Driver>) {
		this.definition = definition;
		this.instance = definition.create();
		this.driver = this.instance.driver;
	}

	async start(): Promise<void> {
		for (const plugin of this.definition.plugins) await plugin.setup(this.instance.api(plugin.id));
		await this.instance.activate();
	}

	close(): void {
		this.instance.close();
	}
}
