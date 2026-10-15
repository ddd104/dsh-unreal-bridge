import test from "node:test";
import assert from "node:assert/strict";
import { validateEdgeRecord, validateNodeRecord } from "../src/graph/schema.js";

test("schema validates node and edge records", () => {
  assert.deepEqual(
    validateNodeRecord({
      id: "file:Example.h",
      type: "File",
      name: "Example.h",
      path: "Source/Example.h",
      system: "Example",
      language: "Cpp",
      summary: "Example file",
      metadata: {}
    }),
    []
  );

  assert.deepEqual(
    validateEdgeRecord({
      from: "file:Example.h",
      to: "class:Example",
      type: "DECLARES",
      metadata: {}
    }),
    []
  );

  assert.ok(validateNodeRecord({ id: "bad", type: "Bogus" }).length > 0);
});
