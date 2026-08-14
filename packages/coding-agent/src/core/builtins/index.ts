import type { InlineExtension } from "../extensions/types.ts";
import duetBuiltin from "./duet.ts";
import subagentBuiltin from "./subagent.ts";

/**
 * Extensions that ship as part of the coding-agent core.
 *
 * Unlike project/global extensions (opt-in via settings `packages` or
 * `.draht/extensions/`), these are always loaded by `createAgentSessionServices`
 * regardless of settings, `--no-extensions`, or project trust — the same way
 * the core bash/read/write/edit tools are always available.
 */
export const CORE_BUILTIN_EXTENSIONS: InlineExtension[] = [
	{ name: "multi-agent", factory: subagentBuiltin },
	{ name: "duet", factory: duetBuiltin },
];
