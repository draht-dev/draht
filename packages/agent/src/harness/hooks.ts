import type { BeforeResumePrepared, HookHandler, HookInvocation, HookMap, HookName, Hooks } from "./agent-harness.ts";
import type { EffectGate } from "./execution/effect-gate.ts";
import type { JsonValue } from "./session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "./types.ts";

interface HookRegistration {
	id?: string;
	handler: (event: unknown) => unknown | Promise<unknown>;
}

type HookErrorReporter = (error: Error, hook: HookName, lane: string) => void | Promise<void>;

export interface BeforeRunAggregate {
	result: HookMap["before_run"]["result"];
	resumeData: Record<string, JsonValue>;
}

/** Ordered harness hook registry and aggregate runner. */
export class HookRegistry implements Hooks {
	private readonly registrations = new Map<HookName, HookRegistration[]>();
	private readonly reportError: HookErrorReporter;
	private closedError: Error | undefined;

	constructor(reportError: HookErrorReporter) {
		this.reportError = reportError;
	}

	on<TName extends HookName>(name: TName, handler: HookHandler<TName>, options: { id?: string } = {}): () => void {
		if (this.closedError !== undefined) throw this.closedError;
		if ((name === "before_run" || name === "before_resume") && options.id === undefined) {
			throw new Error(`${name} hooks require a stable id`);
		}
		const registrations = this.registrations.get(name) ?? [];
		if (options.id !== undefined && registrations.some((registration) => registration.id === options.id)) {
			throw new Error(`Duplicate ${name} hook id: ${options.id}`);
		}
		const registration: HookRegistration = {
			...(options.id === undefined ? {} : { id: options.id }),
			handler: (event) => handler(event as HookInvocation<TName>),
		};
		registrations.push(registration);
		this.registrations.set(name, registrations);
		return () => {
			const index = registrations.indexOf(registration);
			if (index !== -1) registrations.splice(index, 1);
		};
	}

	/** Invoke one accepted-operation aggregate after synchronously passing its effect gate. */
	runWithGate<TName extends HookName>(
		name: TName,
		event: HookInvocation<TName>,
		effectGate: EffectGate,
	): Promise<HookMap[TName]["result"]> {
		effectGate.assertOpen();
		return this.runAdmitted(name, event);
	}

	/** Preserve each before_run handler's restart data under its stable id. */
	runBeforeAcceptanceWithResumeData(
		event: HookInvocation<"before_run">,
		assertHarnessOpen: () => void,
	): Promise<BeforeRunAggregate> {
		assertHarnessOpen();
		return this.beforeRunAggregate(event);
	}

	/** Give each before_resume handler only the restart data written by its matching before_run id. */
	runBeforeResumeWithGate(
		event: BeforeResumePrepared & { lane: string; runId: string },
		resumeData: Readonly<Record<string, JsonValue>>,
		effectGate: EffectGate,
	): Promise<void> {
		effectGate.assertOpen();
		return this.beforeResumeAdmitted(event, resumeData);
	}

	close(error: Error): void {
		this.closedError ??= error;
	}

	private async runAdmitted<TName extends HookName>(
		name: TName,
		event: HookInvocation<TName>,
	): Promise<HookMap[TName]["result"]> {
		if (this.closedError !== undefined) throw this.closedError;
		const result = await this.aggregate(name, event);
		return result as HookMap[TName]["result"];
	}

	private async aggregate(name: HookName, event: HookInvocation<HookName>): Promise<unknown> {
		switch (name) {
			case "before_run":
				return (await this.beforeRunAggregate(event as HookInvocation<"before_run">)).result;
			case "before_resume":
				await this.invokeAll(name, event, () => {});
				return undefined;
			case "before_run_end": {
				let followUp: string | undefined;
				await this.invokeAll(name, event, (value) => {
					const result = value as HookMap["before_run_end"]["result"];
					if (result?.followUp !== undefined) followUp = result.followUp;
				});
				return followUp === undefined ? undefined : { followUp };
			}
			case "transform_context":
				return this.transformContext(event as HookInvocation<"transform_context">);
			case "before_request":
				return this.beforeRequest(event as HookInvocation<"before_request">);
			case "before_payload":
				return this.beforePayload(event as HookInvocation<"before_payload">);
			case "after_response":
				return this.afterResponse(event as HookInvocation<"after_response">);
			case "before_tool":
				return this.beforeTool(event as HookInvocation<"before_tool">);
			case "after_tool":
				return this.afterTool(event as HookInvocation<"after_tool">);
			case "before_compaction":
				return this.firstStructural(name, event as HookInvocation<"before_compaction">, "compaction");
			case "before_navigation":
				return this.firstStructural(name, event as HookInvocation<"before_navigation">, "summary");
		}
	}

	private async beforeRunAggregate(event: HookInvocation<"before_run">): Promise<BeforeRunAggregate> {
		let prompt = event.prompt;
		let systemPrompt = event.systemPrompt;
		let injected: HookMap["before_run"]["event"]["prompt"] = [];
		const resumeData = Object.create(null) as Record<string, JsonValue>;
		for (const registration of this.registrationsFor("before_run")) {
			try {
				const result = (await registration.handler({
					...event,
					prompt,
					systemPrompt,
				})) as HookMap["before_run"]["result"];
				if (result?.messages !== undefined) {
					injected = [...injected, ...result.messages];
					prompt = [...prompt, ...result.messages];
				}
				if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
				if (result?.resumeData !== undefined) resumeData[registration.id!] = result.resumeData;
			} catch (error) {
				await this.reportError(error instanceof Error ? error : new Error(String(error)), "before_run", event.lane);
			}
		}
		return {
			result: {
				...(injected.length === 0 ? {} : { messages: injected }),
				...(systemPrompt === event.systemPrompt ? {} : { systemPrompt }),
			},
			resumeData,
		};
	}

	private async beforeResumeAdmitted(
		event: BeforeResumePrepared & { lane: string; runId: string },
		resumeData: Readonly<Record<string, JsonValue>>,
	): Promise<void> {
		if (this.closedError !== undefined) throw this.closedError;
		for (const registration of this.registrationsFor("before_resume")) {
			try {
				const data =
					registration.id !== undefined && Object.hasOwn(resumeData, registration.id)
						? resumeData[registration.id]
						: undefined;
				await registration.handler({
					...event,
					...(data === undefined ? {} : { resumeData: data }),
				});
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_resume",
					event.lane,
				);
			}
		}
	}

	private async beforeTool(event: HookInvocation<"before_tool">): Promise<HookMap["before_tool"]["result"]> {
		let args = event.args;
		let block: { reason: string; terminate?: boolean } | undefined;
		for (const registration of this.registrationsFor("before_tool")) {
			try {
				const result = (await registration.handler({ ...event, args })) as HookMap["before_tool"]["result"];
				if (result?.args !== undefined) args = result.args;
				if (result?.block !== undefined) {
					block = result.block;
					break;
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				await this.reportError(normalized, "before_tool", event.lane);
				block = { reason: normalized.message };
				break;
			}
		}
		return {
			...(args === event.args ? {} : { args }),
			...(block === undefined ? {} : { block }),
		};
	}

	private async transformContext(
		event: HookInvocation<"transform_context">,
	): Promise<HookMap["transform_context"]["result"]> {
		let messages = event.messages;
		for (const registration of this.registrationsFor("transform_context")) {
			try {
				const result = (await registration.handler({
					...event,
					messages,
				})) as HookMap["transform_context"]["result"];
				if (result?.messages !== undefined) messages = result.messages;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"transform_context",
					event.lane,
				);
			}
		}
		return { messages };
	}

	private async beforeRequest(event: HookInvocation<"before_request">): Promise<HookMap["before_request"]["result"]> {
		let streamOptions = event.streamOptions;
		let changed = false;
		for (const registration of this.registrationsFor("before_request")) {
			try {
				const result = (await registration.handler({
					...event,
					streamOptions,
				})) as HookMap["before_request"]["result"];
				if (result?.streamOptions !== undefined) {
					streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
					changed = true;
				}
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_request",
					event.lane,
				);
			}
		}
		return changed ? { streamOptions: createStreamOptionsPatch(event.streamOptions, streamOptions) } : undefined;
	}

	private async beforePayload(event: HookInvocation<"before_payload">): Promise<HookMap["before_payload"]["result"]> {
		let payload = event.payload;
		for (const registration of this.registrationsFor("before_payload")) {
			try {
				const result = (await registration.handler({ ...event, payload })) as HookMap["before_payload"]["result"];
				if (result?.payload !== undefined) payload = result.payload;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_payload",
					event.lane,
				);
			}
		}
		return { payload };
	}

	private async afterResponse(event: HookInvocation<"after_response">): Promise<HookMap["after_response"]["result"]> {
		let message = event.message;
		for (const registration of this.registrationsFor("after_response")) {
			try {
				const result = (await registration.handler({ ...event, message })) as HookMap["after_response"]["result"];
				if (result?.message !== undefined) message = result.message;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"after_response",
					event.lane,
				);
			}
		}
		return { message };
	}

	private async afterTool(event: HookInvocation<"after_tool">): Promise<HookMap["after_tool"]["result"]> {
		let current = {
			content: event.content,
			details: event.details,
			isError: event.isError,
			usage: event.usage,
		};
		const aggregate: NonNullable<HookMap["after_tool"]["result"]> = {};
		for (const registration of this.registrationsFor("after_tool")) {
			try {
				const result = (await registration.handler({ ...event, ...current })) as HookMap["after_tool"]["result"];
				if (result === undefined) continue;
				if (result.content !== undefined) aggregate.content = result.content;
				if (result.details !== undefined) aggregate.details = result.details;
				if (result.isError !== undefined) aggregate.isError = result.isError;
				if (result.usage !== undefined) aggregate.usage = result.usage;
				if (result.terminate !== undefined) aggregate.terminate = result.terminate;
				current = {
					content: result.content === undefined ? current.content : result.content,
					details: result.details === undefined ? current.details : result.details,
					isError: result.isError === undefined ? current.isError : result.isError,
					usage: result.usage === undefined ? current.usage : result.usage,
				};
			} catch (error) {
				await this.reportError(error instanceof Error ? error : new Error(String(error)), "after_tool", event.lane);
			}
		}
		return Object.keys(aggregate).length === 0 ? undefined : aggregate;
	}

	private async firstStructural(
		name: "before_compaction" | "before_navigation",
		event: HookInvocation<"before_compaction"> | HookInvocation<"before_navigation">,
		resultField: "compaction" | "summary",
	): Promise<unknown> {
		for (const registration of this.registrationsFor(name)) {
			try {
				const value = await registration.handler(event);
				if (value === undefined || value === null || typeof value !== "object") continue;
				const result = value as Record<string, unknown>;
				if (result.decline === true && result[resultField] !== undefined) {
					await this.reportError(
						new Error(`${name} hook cannot return both decline and ${resultField}`),
						name,
						event.lane,
					);
					continue;
				}
				if (result.decline === true || result[resultField] !== undefined) return value;
			} catch (error) {
				await this.reportError(error instanceof Error ? error : new Error(String(error)), name, event.lane);
			}
		}
		return undefined;
	}

	private registrationsFor(name: HookName): HookRegistration[] {
		return [...(this.registrations.get(name) ?? [])];
	}

	private async invokeAll(
		name: HookName,
		event: HookInvocation<HookName>,
		apply: (value: unknown) => void,
	): Promise<void> {
		for (const registration of this.registrationsFor(name)) {
			try {
				apply(await registration.handler(event));
			} catch (error) {
				await this.reportError(error instanceof Error ? error : new Error(String(error)), name, event.lane);
			}
		}
	}
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const next: AgentHarnessStreamOptions = { ...base };
	for (const key of [
		"transport",
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"cacheRetention",
		"deferred",
	] as const) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (value === undefined) delete next[key];
		else Object.assign(next, { [key]: value });
	}
	if ("headers" in patch) {
		if (patch.headers === undefined) delete next.headers;
		else {
			const headers = { ...next.headers };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			next.headers = headers;
		}
	}
	if ("metadata" in patch) {
		if (patch.metadata === undefined) delete next.metadata;
		else {
			const metadata = { ...next.metadata };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			next.metadata = metadata;
		}
	}
	return next;
}

function createStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	value: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
	const patch: AgentHarnessStreamOptionsPatch = {};
	for (const key of [
		"transport",
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"cacheRetention",
		"deferred",
	] as const) {
		if (base[key] !== value[key]) Object.assign(patch, { [key]: value[key] });
	}
	if (base.headers !== value.headers) {
		if (value.headers === undefined) patch.headers = undefined;
		else {
			const headers: Record<string, string | undefined> = {};
			for (const key of Object.keys(base.headers ?? {})) {
				if (!(key in value.headers)) headers[key] = undefined;
			}
			for (const [key, header] of Object.entries(value.headers)) {
				if (base.headers?.[key] !== header) headers[key] = header;
			}
			if (base.headers === undefined && Object.keys(headers).length === 0) patch.headers = {};
			else if (Object.keys(headers).length !== 0) patch.headers = headers;
		}
	}
	if (base.metadata !== value.metadata) {
		if (value.metadata === undefined) patch.metadata = undefined;
		else {
			const metadata: Record<string, unknown | undefined> = {};
			for (const key of Object.keys(base.metadata ?? {})) {
				if (!(key in value.metadata)) metadata[key] = undefined;
			}
			for (const [key, metadataValue] of Object.entries(value.metadata)) {
				if (base.metadata?.[key] !== metadataValue) metadata[key] = metadataValue;
			}
			if (base.metadata === undefined && Object.keys(metadata).length === 0) patch.metadata = {};
			else if (Object.keys(metadata).length !== 0) patch.metadata = metadata;
		}
	}
	return patch;
}
