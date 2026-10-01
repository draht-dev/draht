/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Draht infrastructure — SST v4 serverless stack.
 *
 * Resources:
 * - DynamoDB: Sessions table, Clients table
 * - API Gateway V2: HTTP API with Lambda integrations
 * - Lambda: Health, sessions, clients, bug-reports handlers
 * - S3: BugReports bucket (private, encrypted, 180-day expiration)
 * - API Gateway V2: Radius HTTP API (radius.draht.dev) for bug report intake
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

		// Bug report intake: a private bucket behind its own API Gateway
		const bugReports = new sst.aws.Bucket("BugReports", {
			transform: {
				bucket: {
					serverSideEncryptionConfiguration: {
						rule: { applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } },
					},
				},
				lifecycle: {
					rules: [{ id: "expire-bug-reports", status: "Enabled", filter: {}, expiration: { days: 180 } }],
				},
			},
		});

		const radius = new sst.aws.ApiGatewayV2("Radius", {
			domain: { name: "radius.draht.dev", dns: sst.aws.dns() },
			transform: {
				stage: {
					defaultRouteSettings: { throttlingBurstLimit: 20, throttlingRateLimit: 5 },
				},
			},
		});

		radius.route("POST /v1/bug-reports", {
			handler: "src/functions/bug-reports.handler",
			link: [bugReports],
		});

		return { api: api.url, radius: radius.url };
	},
});
