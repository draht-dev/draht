import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
// import { Resource } from "sst"; // Available when deployed

export const handler: APIGatewayProxyHandlerV2 = async () => {
	// TODO: Query Clients table via Resource.Clients.name
	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			clients: [],
			message: "Clients endpoint — connect to DynamoDB when deployed",
		}),
	};
};
