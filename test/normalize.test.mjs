import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessages } from "../index.js";

test("normalizeMessages: replaces content null with empty string", () => {
  const result = normalizeMessages([
    { role: "user", content: null },
    { role: "user", content: "hello" },
    { role: "assistant", content: null }
  ]);
  assert.equal(result[0].content, "");
  assert.equal(result[1].content, "hello");
  assert.equal(result[2].content, "");
});

test("normalizeMessages: adds reasoning_content when reasoningEffort is set and assistant lacks it", () => {
  const result = normalizeMessages([
    { role: "assistant", content: "hi" },
    { role: "assistant", content: "there", reasoning_content: "thinking" },
    { role: "user", content: "hello" }
  ], "high");
  assert.equal(result[0].reasoning_content, "");
  assert.equal(result[1].reasoning_content, "thinking");
  assert.equal(result[2].reasoning_content, undefined);
});

test("normalizeMessages: no reasoning_content when reasoningEffort is not set", () => {
  const result = normalizeMessages([{ role: "assistant", content: "hi" }]);
  assert.equal(result[0].reasoning_content, undefined);
});

test("normalizeMessages: handles null reasoning_content", () => {
  const result = normalizeMessages([
    { role: "assistant", content: "hi", reasoning_content: null }
  ], "medium");
  assert.equal(result[0].reasoning_content, "");
});

test("normalizeMessages: skips non-objects", () => {
  const result = normalizeMessages([null, "string", 42]);
  assert.equal(result[0], null);
  assert.equal(result[1], "string");
  assert.equal(result[2], 42);
});

test("normalizeMessages: does not mutate input", () => {
  const input = [{ role: "assistant", content: null }];
  const result = normalizeMessages(input, "low");
  assert.equal(input[0].content, null);
  assert.equal(result[0].content, "");
  assert.ok(result !== input);
});
