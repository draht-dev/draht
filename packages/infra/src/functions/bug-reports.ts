import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { Resource } from "sst";
import { handleBugReportUpload } from "./bug-reports/core.ts";

const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
	return handleBugReportUpload(
		{
			headers: (event.headers ?? {}) as Record<string, string | undefined>,
			body: event.body,
			isBase64Encoded: event.isBase64Encoded ?? false,
		},
		{
			putObject: async (key, part) => {
				await s3.send(
					new PutObjectCommand({
						Bucket: Resource.BugReports.name,
						Key: key,
						Body: part.data,
						ContentType: part.contentType,
						ServerSideEncryption: "AES256",
					}),
				);
			},
		},
	);
};
