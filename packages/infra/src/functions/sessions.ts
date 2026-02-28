import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
// import { Resource } from "sst"; // Available when deployed

export const handler: APIGatewayProxyHandlerV2 = async () => {
	// TODO: Query Sessions table via Resource.Sessions.name
	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			sessions: [],
			message: "Sessions endpoint — connect to DynamoDB when deployed",
		}),
	};
};
