import * as bundledPiAgentCore from "@draht/agent-core";
import * as bundledPiAiModels from "@draht/ai/models";
import * as bundledPiAiOauth from "@draht/ai/oauth";
import * as bundledPiAiProviders from "@draht/ai/providers/all";
import * as bundledPiAiProvidersFaux from "@draht/ai/providers/faux";
import * as bundledPiTui from "@draht/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @draht/coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiExtensionView from "./ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@draht/agent-core": bundledPiAgentCore,
	"@draht/tui": bundledPiTui,
	// Extensions resolve the @draht/ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and @draht/ai's former
	// TypeBox re-exports keep working.
	"@draht/ai": bundledPiAiExtensionView,
	"@draht/ai/compat": bundledPiAiExtensionView,
	"@draht/ai/models": bundledPiAiModels,
	"@draht/ai/oauth": bundledPiAiOauth,
	"@draht/ai/providers/all": bundledPiAiProviders,
	// Every @draht/ai subpath an extension may import needs its own entry here and
	// in getAliases(): the bare "@draht/ai" key below is a PREFIX match, so an
	// unlisted subpath is rewritten onto the compat entrypoint
	// ("<compat.js>/providers/faux") and fails to resolve.
	"@draht/ai/providers/faux": bundledPiAiProvidersFaux,
	"@draht/coding-agent": bundledPiCodingAgent,
};
