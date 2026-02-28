/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Draht infrastructure — SST v4 serverless stack.
 *
 * Resources:
 * - DynamoDB: Sessions table, Clients table
 * - API Gateway V2: HTTP API with Lambda integrations
 * - Lambda: Health, sessions, clients handlers
 *
 * WARNING: Never run `sst deploy` from development environments.
 */
export default $config({
	app(input) {
		return {
			name: "draht",
			removal: input?.stage === "production" ? "retain" : "remove",
			home: "aws",
		};
	},
	async run() {
		// DynamoDB tables
		const sessionsTable = new sst.aws.Dynamo("Sessions", {
			fields: { pk: "string", sk: "string" },
			primaryIndex: { hashKey: "pk", rangeKey: "sk" },
		});

		const clientsTable = new sst.aws.Dynamo("Clients", {
			fields: { clientId: "string" },
			primaryIndex: { hashKey: "clientId" },
		});

		// API Gateway
		const api = new sst.aws.ApiGatewayV2("Api");

		api.route("GET /health", {
			handler: "src/functions/health.handler",
			link: [sessionsTable, clientsTable],
		});

		api.route("GET /sessions", {
			handler: "src/functions/sessions.handler",
			link: [sessionsTable],
		});

		api.route("GET /clients", {
			handler: "src/functions/clients.handler",
			link: [clientsTable],
		});

		return { api: api.url };
	},
});
