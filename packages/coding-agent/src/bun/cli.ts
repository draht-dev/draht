#!/usr/bin/env node
// Restore the environment before evaluating modules that read it at startup.
import "./sandbox-env-setup.ts";
import { registerBunOAuthFlows } from "@draht/ai/bun-oauth";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();
setEmbeddedQuickJSWasmPath(quickjsWasmPath);

await import("./register-bedrock.ts");
await import("../cli.ts");
