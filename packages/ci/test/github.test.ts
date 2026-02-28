import assert from "node:assert";
import { describe, it } from "node:test";

// Test formatCommentBody (extracted for testability)

function formatCommentBody(comment: { severity: string; body: string }): string {
	const icon = comment.severity === "critical" ? "🔴" : comment.severity === "warning" ? "🟡" : "🔵";
	return `${icon} **${comment.severity.toUpperCase()}**\n\n${comment.body}`;
}

describe("formatCommentBody", () => {
	it("formats critical with red icon", () => {
		const result = formatCommentBody({ severity: "critical", body: "SQL injection risk" });
		assert.ok(result.includes("🔴"));
		assert.ok(result.includes("**CRITICAL**"));
		assert.ok(result.includes("SQL injection risk"));
	});

	it("formats warning with yellow icon", () => {
		const result = formatCommentBody({ severity: "warning", body: "Missing error handling" });
		assert.ok(result.includes("🟡"));
		assert.ok(result.includes("**WARNING**"));
	});

	it("formats info with blue icon", () => {
		const result = formatCommentBody({ severity: "info", body: "Consider renaming" });
		assert.ok(result.includes("🔵"));
		assert.ok(result.includes("**INFO**"));
	});
});
