import test from "node:test";
import assert from "node:assert/strict";
import { projectMessages } from "../index.js";
import {
  collectToolCall, restoreSummariesFromBranch, getSummaries,
  getPendingToolCalls, resetPendingToolCalls, hasPendingToolCalls
} from "../src/summary.js";

function resetAll() {
  resetPendingToolCalls();
  restoreSummariesFromBranch([]);
}

// ── projectMessages ──

test("projectMessages: passes through with no summaries", () => {
  const result = projectMessages([
    { role: "user", content: "hello" },
    { role: "toolResult", toolCallId: "call1", content: "result1" }
  ]);
  assert.equal(result.length, 2);
});

test("projectMessages: collapses matched toolResults with multiple primary summaries", () => {
  restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c1", "c2"], latestId: "c2", text: "sum1" } },
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c3", "c4"], latestId: "c4", text: "sum2" } }
  ]);
  const result = projectMessages([
    { role: "user", content: "hi" },
    { role: "toolResult", toolCallId: "c1", content: "x" },
    { role: "toolResult", toolCallId: "c2", content: "y" },
    { role: "toolResult", toolCallId: "c3", content: "z" },
    { role: "toolResult", toolCallId: "c4", content: "w" },
    { role: "toolResult", toolCallId: "c5", content: "fresh" }
  ]);
  assert.equal(result.length, 6);
  assert.ok(result[2].content[0].text.includes("sum1"));
  assert.ok(result[4].content[0].text.includes("sum2"));
  assert.equal(result[5].content, "fresh");
  resetAll();
});

test("projectMessages: projects global summary with collapsed msg IDs", () => {
  restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["msg1", "msg2"], text: "global summary", timestamp: 1000 } }
  ]);
  const result = projectMessages([
    { role: "system", content: "sys" },
    { id: "msg1", role: "user", content: "a" },
    { id: "msg2", role: "assistant", content: "b" },
    { id: "msg3", role: "user", content: "c" }
  ]);
  const sumMsg = result.find(m => m.id && m.id.startsWith("global-sum-"));
  assert.ok(sumMsg);
  assert.ok(sumMsg.content[0].text.includes("global summary"));
  assert.equal(result.find(m => m.id === "msg1").content.length, 0);
  assert.equal(result.find(m => m.id === "msg2").content.length, 0);
  assert.equal(result.find(m => m.id === "msg3").content, "c");
  resetAll();
});

test("projectMessages: ignores unmatched summary IDs", () => {
  restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["nonexistent"], latestId: "nonexistent", text: "ghost" } }
  ]);
  const result = projectMessages([
    { role: "user", content: "hi" },
    { role: "toolResult", toolCallId: "real1", content: "real" }
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].content, "real");
  resetAll();
});

test("projectMessages: handles messages without toolCallId", () => {
  restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c1"], latestId: "c1", text: "s" } }
  ]);
  const result = projectMessages([
    { role: "toolResult", content: "no id" }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "no id");
  resetAll();
});

// ── collectToolCall ──

test("collectToolCall: collects matching tool calls from event", () => {
  resetAll();
  collectToolCall({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }] },
    toolResults: [{ toolCallId: "tc1", content: [{ type: "text", text: "result" }] }]
  });
  assert.equal(hasPendingToolCalls(), true);
  assert.equal(getPendingToolCalls().length, 1);
  assert.equal(getPendingToolCalls()[0].id, "tc1");
  assert.equal(getPendingToolCalls()[0].name, "read");
  resetAll();
});

test("collectToolCall: skips when no tool results match", () => {
  resetAll();
  collectToolCall({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: []
  });
  assert.equal(hasPendingToolCalls(), false);
  resetAll();
});

test("collectToolCall: handles missing message content", () => {
  resetAll();
  collectToolCall({ message: {}, toolResults: [] });
  assert.equal(hasPendingToolCalls(), false);
  resetAll();
});

test("collectToolCall: uses fallback field names", () => {
  resetAll();
  collectToolCall({
    message: { content: [{ type: "toolCall", toolCallId: "tc1", toolName: "search", input: { q: "test" } }] },
    toolResults: [{ id: "tc1", content: "plain" }]
  });
  assert.equal(getPendingToolCalls().length, 1);
  assert.equal(getPendingToolCalls()[0].id, "tc1");
  assert.equal(getPendingToolCalls()[0].name, "search");
  assert.deepEqual(getPendingToolCalls()[0].args, { q: "test" });
  assert.equal(getPendingToolCalls()[0].result, "plain");
  resetAll();
});

// ── restoreSummariesFromBranch ──

test("restoreSummariesFromBranch: restores primary and global entries", () => {
  resetAll();
  restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["a", "b"], latestId: "b", text: "primary" } },
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["x", "y"], text: "global", timestamp: 2000 } },
    { type: "other", customType: "something" }
  ]);
  assert.equal(getSummaries().length, 2);
  assert.equal(getSummaries()[0].type, "primary");
  assert.equal(getSummaries()[0].text, "primary");
  assert.equal(getSummaries()[1].type, "global");
  assert.ok(getSummaries()[1].collapsedIds.has("x"));
  resetAll();
});

test("restoreSummariesFromBranch: empty branch yields empty summaries", () => {
  resetAll();
  restoreSummariesFromBranch([]);
  assert.equal(getSummaries().length, 0);
});
