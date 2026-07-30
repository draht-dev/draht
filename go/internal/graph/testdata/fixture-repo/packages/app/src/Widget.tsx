// A .tsx file: exercises the tsx grammar (distinct from plain typescript,
// see parse.grammarFor's extension-based split).
import { lazyValue } from "./lazy";

export function Widget() {
  return lazyValue();
}
