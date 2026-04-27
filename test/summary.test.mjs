import test from "node:test";
import assert from "node:assert/strict";
import { projectMessages } from "../index.js";

test("projectMessages: passes through with no summaries", () => {
  const result = projectMessages([
    { role: "user", content: "hello" },
    { role: "toolResult", toolCallId: "call1", content: "result1" }
  ]);
  assert.equal(result.length, 2);
});
