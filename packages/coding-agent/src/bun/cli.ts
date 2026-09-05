#!/usr/bin/env node
// Restore the environment before evaluating modules that read it at startup.
import "./sandbox-env-setup.ts";
import { registerBunOAuthFlows } from "@draht/ai/bun-oauth";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();

await import("./register-bedrock.ts");
await import("../cli.ts");
