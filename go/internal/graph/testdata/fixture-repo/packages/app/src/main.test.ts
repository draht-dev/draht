// A ".test.ts" file: exercises scan.IsTest's filename-pattern branch.
import { helper } from "@fixture/core";

test("helper returns 1", () => {
  if (helper() !== 1) {
    throw new Error("expected 1");
  }
});
