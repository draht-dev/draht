import { defineFacet } from "../facets.ts";
import { SlashCommands } from "../services/slash-commands.ts";

/** Example presentation facet. A future plugin build emits this facet as one standalone bundle. */
const helloPluginFacet = defineFacet({
	id: "@pi/example-hello",
	setup(env) {
		const commands = env.use(SlashCommands);
		env.onActivate(() => {
			env.own(
				commands.register({
					name: "hello",
					description: "Send a greeting from the example plugin",
					async run(args, context) {
						await context.submitPrompt(args.length === 0 ? "Hello from the example plugin." : args);
					},
				}),
			);
		});
	},
});

export default helloPluginFacet;
