/**
 * Built-in extension that exposes the keyless stub provider to a SPAWNED draht
 * binary (R32-FLEET.11). Shipped like the llama.cpp extension — hidden, inline,
 * inside the emitted binary — but registering nothing at all unless
 * `DRAHT_STUB_PROVIDER` is truthy, so an ordinary run never sees it.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createStubProvider, isStubProviderEnabled } from "./provider.ts";

export default function stubProviderExtension(pi: ExtensionAPI): void {
	if (!isStubProviderEnabled()) return;
	pi.registerProvider(createStubProvider());
}
