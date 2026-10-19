// Adapters describe argv and parse output; the runner owns process limits and files.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OWNED_FLAGS = new Set([
	"--", "--mode", "--print", "-p", "--provider", "--model", "--models", "--thinking", "--api-key",
	"--system-prompt", "--append-system-prompt", "--continue", "-c", "--resume", "-r", "--session", "--session-id",
	"--session-dir", "--no-session", "--fork", "--attach", "--attachable", "--no-attachable", "--list-sessions",
	"--extension", "-e", "--no-extensions", "-ne", "--skill", "--no-skills", "-ns", "--prompt-template",
	"--no-prompt-templates", "-np", "--no-context-files", "-nc", "--context-root", "--approve", "-a",
	"--no-approve", "-na", "--tools", "-t", "--exclude-tools", "-xt", "--no-tools", "-nt", "--no-builtin-tools",
	"-nbt", "--theme", "--use-theme", "--no-themes", "--offline", "--help", "-h", "--version", "-v", "--export", "--list-models",
]);
const METRICS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"];

function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a nonempty string`);
	return value;
}

function metric(value, label, integer = true) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
		throw new Error(`${label} must be a nonnegative ${integer ? "safe integer" : "finite number"} or null`);
	}
	return value;
}

function unknownUsage() {
	return Object.fromEntries(METRICS.map((name) => [name, null]));
}

export function buildInvocation(config, paths) {
	if (!Array.isArray(config.command) || !config.command.length) throw new Error("Runner command must be a nonempty argv array");
	const command = config.command.map((arg) => text(arg, "Runner argument"));
	text(config.provider, "Runner provider");
	text(config.model, "Runner model");
	if (!object(config.settings)) throw new Error("Runner settings must be an object");
	for (const value of Object.values(config.settings)) {
		if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
			throw new Error("Runner settings must contain only finite numbers, strings, or booleans");
		}
	}
	for (const name of ["workspace", "promptFile", "taskFile"]) text(paths[name], name);
	if (typeof paths.prompt !== "string" || typeof paths.task !== "string") throw new Error("Prompt and task must be strings");
	if (config.format === "json") {
		const replacements = new Map([["{workspace}", paths.workspace], ["{prompt}", paths.promptFile], ["{task}", paths.taskFile]]);
		return {
			command: command.map((arg) => {
				if (replacements.has(arg)) return replacements.get(arg);
				if (/\{(?:workspace|prompt|task)\}/.test(arg)) throw new Error("Runner placeholders must occupy a complete argument");
				return arg;
			}),
			stdin: `${JSON.stringify({ ...paths, provider: config.provider, model: config.model, settings: config.settings })}\n`,
		};
	}
	if (config.format !== "draht-jsonl") throw new Error(`Unsupported runner format: ${config.format}`);
	for (const arg of command.slice(1)) {
		if (OWNED_FLAGS.has(arg.split("=", 1)[0]) || arg.startsWith("@") || /\{(?:workspace|prompt|task)\}/.test(arg)) {
			throw new Error(`Native runner argument is controlled by drahtbank: ${arg}`);
		}
	}
	for (const name of Object.keys(config.settings)) {
		if (name !== "thinking") throw new Error(`Unsupported native runner setting: ${name}`);
	}
	if (config.settings.thinking !== undefined && !THINKING_LEVELS.has(config.settings.thinking)) {
		throw new Error("Invalid native thinking setting");
	}
	command.push(
		"--mode", "json", "--print", "--no-session", "--no-attachable", "--no-context-files", "--no-skills",
		"--no-prompt-templates", "--no-extensions", "--no-themes", "--no-approve", "--offline",
		"--tools", `read,${process.platform === "win32" ? "powershell" : "bash"},edit,write,grep,find,ls`,
		"--provider", config.provider, "--model", config.model,
	);
	if (config.settings.thinking !== undefined) command.push("--thinking", config.settings.thinking);
	command.push("--append-system-prompt", paths.promptFile, "--", `@${paths.taskFile}`);
	return { command, stdin: "" };
}

function parseJson(stdout) {
	const value = JSON.parse(stdout);
	if (!object(value)) throw new Error("Adapter output must be a JSON object");
	for (const key of Object.keys(value)) {
		if (!["finalText", "usage", "toolCalls", "error"].includes(key)) throw new Error(`Unknown adapter output field: ${key}`);
	}
	if (value.error !== undefined && value.error !== null) text(value.error, "Adapter error");
	if (typeof value.finalText !== "string" || (!value.error && !value.finalText.trim())) {
		throw new Error("Adapter output requires finalText (nonempty unless an error is reported)");
	}
	const usage = unknownUsage();
	if (value.usage !== undefined && value.usage !== null) {
		if (!object(value.usage)) throw new Error("Adapter usage must be an object or null");
		for (const name of Object.keys(value.usage)) {
			if (!METRICS.includes(name)) throw new Error(`Unknown adapter usage field: ${name}`);
			usage[name] = metric(value.usage[name], name, name !== "costUsd");
		}
	}
	return { finalText: value.finalText, usage, toolCalls: metric(value.toolCalls, "toolCalls"), error: value.error ?? null };
}

function nativeUsage(value) {
	if (value === undefined || value === null) return unknownUsage();
	if (!object(value)) throw new Error("Assistant usage must be an object");
	if (value.cost !== undefined && value.cost !== null && !object(value.cost)) throw new Error("Assistant cost must be an object");
	return {
		inputTokens: metric(value.input, "usage.input"),
		outputTokens: metric(value.output, "usage.output"),
		cacheReadTokens: metric(value.cacheRead, "usage.cacheRead"),
		cacheWriteTokens: metric(value.cacheWrite, "usage.cacheWrite"),
		costUsd: metric(value.cost?.total, "usage.cost.total", false),
	};
}

function parseDraht(stdout) {
	let finalText = "";
	let terminalMessage;
	let completed = false;
	let incompleteAssistant = false;
	let assistantCount = 0;
	let toolCalls = 0;
	const usage = Object.fromEntries(METRICS.map((name) => [name, 0]));
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const event = JSON.parse(line);
		if (!object(event) || typeof event.type !== "string") throw new Error("Malformed Draht JSONL event");
		if (event.type === "agent_start") {
			completed = false;
			terminalMessage = undefined;
			finalText = "";
		}
		if (event.type === "agent_end") completed = true;
		if ((event.type === "message_start" && event.message?.role === "assistant") || event.type === "message_update") {
			incompleteAssistant = true;
			completed = false;
		}
		if (event.type === "tool_execution_start") {
			text(event.toolCallId, "Tool call ID");
			text(event.toolName, "Tool name");
			toolCalls++;
			completed = false;
		}
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "error") {
			terminalMessage = event.assistantMessageEvent.error;
			completed = false;
		}
		if (event.type !== "message_end") continue;
		if (!object(event.message) || typeof event.message.role !== "string") throw new Error("Malformed message_end event");
		if (event.message.role !== "assistant") continue;
		terminalMessage = event.message;
		completed = false;
		incompleteAssistant = false;
		assistantCount++;
		if (!Array.isArray(terminalMessage.content)) throw new Error("Assistant content must be an array");
		const parts = [];
		for (const part of terminalMessage.content) {
			if (!object(part) || typeof part.type !== "string") throw new Error("Malformed assistant content");
			if (part.type === "text") {
				if (typeof part.text !== "string") throw new Error("Assistant text must be a string");
				parts.push(part.text);
			}
		}
		finalText = parts.join("\n");
		const measured = nativeUsage(terminalMessage.usage);
		for (const name of METRICS) {
			usage[name] = usage[name] === null || measured[name] === null ? null : metric(usage[name] + measured[name], name, name !== "costUsd");
		}
	}
	let error = null;
	if (terminalMessage?.stopReason === "error" || terminalMessage?.stopReason === "aborted") {
		error = typeof terminalMessage.errorMessage === "string" && terminalMessage.errorMessage.trim()
			? terminalMessage.errorMessage : `Assistant ${terminalMessage.stopReason}`;
	} else if (!completed || incompleteAssistant || !assistantCount || terminalMessage?.stopReason !== "stop" || !finalText.trim()) {
		error = "Draht output has no completed final assistant text";
	}
	return { finalText, usage: assistantCount && !incompleteAssistant ? usage : unknownUsage(), toolCalls: assistantCount ? toolCalls : null, error };
}

export function parseOutput(format, stdout) {
	const telemetrySource = format === "draht-jsonl" ? "draht-events" : "adapter-reported";
	try {
		if (typeof stdout !== "string") throw new Error("Runner stdout must be a string");
		if (format !== "draht-jsonl" && format !== "json") throw new Error(`Unsupported runner format: ${format}`);
		return { ...(format === "draht-jsonl" ? parseDraht(stdout) : parseJson(stdout)), telemetrySource };
	} catch (error) {
		return { finalText: "", usage: unknownUsage(), toolCalls: null, telemetrySource, error: error instanceof Error ? error.message : String(error) };
	}
}
