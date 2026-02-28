/**
 * Claude-powered diff reviewer.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface Finding {
	path: string;
	line: number;
	severity: "info" | "warning" | "critical";
	message: string;
	suggestion?: string;
}

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. You review pull request diffs with deep knowledge of the project's conventions and standards.

Your task: analyze the diff and find issues. Focus on:
- Bugs, logic errors, security vulnerabilities (critical)
- Performance issues, missing error handling, anti-patterns (warning)  
- Style inconsistencies, naming issues, documentation gaps (info)

Respond with a JSON array of findings. Each finding:
{
  "path": "file path from diff",
  "line": line number in the new file,
  "severity": "info" | "warning" | "critical",
  "message": "clear description of the issue",
  "suggestion": "optional fix suggestion"
}

If no issues found, return an empty array: []
Only return the JSON array, no other text.`;

/**
 * Review a PR diff using Claude.
 */
export async function reviewDiff(
	diff: string,
	agentsMdContent: string | null,
	model: string,
	apiKey: string,
): Promise<Finding[]> {
	const client = new Anthropic({ apiKey });

	const systemPrompt = agentsMdContent
		? `${REVIEW_SYSTEM_PROMPT}\n\n<project_conventions>\n${agentsMdContent}\n</project_conventions>`
		: REVIEW_SYSTEM_PROMPT;

	const message = await client.messages.create({
		model,
		max_tokens: 4096,
		system: systemPrompt,
		messages: [
			{
				role: "user",
				content: `Review this pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
			},
		],
	});

	const text = message.content
		.filter((block): block is Anthropic.TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("");

	return parseFindings(text);
}

function parseFindings(text: string): Finding[] {
	try {
		// Try to extract JSON array from response
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];

		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(
			(f: unknown): f is Finding =>
				typeof f === "object" &&
				f !== null &&
				typeof (f as Finding).path === "string" &&
				typeof (f as Finding).line === "number" &&
				typeof (f as Finding).message === "string" &&
				["info", "warning", "critical"].includes((f as Finding).severity),
		);
	} catch {
		return [];
	}
}
