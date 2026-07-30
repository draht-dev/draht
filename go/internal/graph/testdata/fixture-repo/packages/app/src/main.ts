// Exercises every import category the fixture is meant to cover:
//   - workspace-resolved bare specifier (@fixture/core -> packages/core/src/index.ts)
//   - node: import (external, unresolved by design)
//   - dynamic import() (resolves to ./lazy)
//   - require() (resolves to ./legacy.js)
//   - unresolvable relative import (./missing does not exist on disk)
import { helper } from "@fixture/core";
import fs from "node:fs";

export function run(): void {
  helper();
  fs.existsSync(".");
  void import("./lazy");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const legacy = require("./legacy");
  void legacy;
}

// @ts-expect-error intentionally unresolvable for the fixture
import "./missing";
