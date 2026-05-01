import test from "node:test";
import assert from "node:assert/strict";
import { createSummarizer } from "../index.js";

function makeSummarizer() {
  const sz = createSummarizer();
  const resetAll = () => {
    sz.resetPendingToolCalls();
    sz.restoreSummariesFromBranch([]);
  };
  return { sz, resetAll };
}

// ── projectMessages ──

test("projectMessages: passes through with no summaries", () => {
  const { sz, resetAll } = makeSummarizer();
  const result = sz.projectMessages([
    { role: "user", content: "hello" },
    { role: "toolResult", toolCallId: "call1", content: "result1" }
  ]);
  assert.equal(result.length, 2);
});

test("projectMessages: collapses matched toolResults with multiple primary summaries", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c1", "c2"], latestId: "c2", text: "sum1" } },
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c3", "c4"], latestId: "c4", text: "sum2" } }
  ]);
  const result = sz.projectMessages([
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
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["user:100", "assistant:101"], text: "global summary", timestamp: 1000 } }
  ]);
  const result = sz.projectMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "a", timestamp: 100 },
    { role: "assistant", content: "b", timestamp: 101 },
    { role: "user", content: "c", timestamp: 102 }
  ]);
  const sumMsg = result.find(m => m.id && m.id.startsWith("global-sum-"));
  assert.ok(sumMsg);
  assert.ok(sumMsg.content[0].text.includes("global summary"));
  assert.equal(result.find(m => m.role === "user" && m.timestamp === 100).content.length, 0);
  assert.equal(result.find(m => m.role === "assistant" && m.timestamp === 101).content.length, 0);
  assert.equal(result.find(m => m.role === "user" && m.timestamp === 102).content, "c");
  resetAll();
});

test("projectMessages: ignores unmatched summary IDs", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["nonexistent"], latestId: "nonexistent", text: "ghost" } }
  ]);
  const result = sz.projectMessages([
    { role: "user", content: "hi" },
    { role: "toolResult", toolCallId: "real1", content: "real" }
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].content, "real");
  resetAll();
});

test("projectMessages: handles messages without toolCallId", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["c1"], latestId: "c1", text: "s" } }
  ]);
  const result = sz.projectMessages([
    { role: "toolResult", content: "no id" }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "no id");
  resetAll();
});

// ── collectToolCall ──

test("collectToolCall: collects matching tool calls from event", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.collectToolCall({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }] },
    toolResults: [{ toolCallId: "tc1", content: [{ type: "text", text: "result" }] }]
  });
  assert.equal(sz.hasPendingToolCalls(), true);
  assert.equal(sz.getPendingToolCalls().length, 1);
  assert.equal(sz.getPendingToolCalls()[0].id, "tc1");
  assert.equal(sz.getPendingToolCalls()[0].name, "read");
  resetAll();
});

test("collectToolCall: skips when no tool results match", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.collectToolCall({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: []
  });
  assert.equal(sz.hasPendingToolCalls(), false);
  resetAll();
});

test("collectToolCall: handles missing message content", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.collectToolCall({ message: {}, toolResults: [] });
  assert.equal(sz.hasPendingToolCalls(), false);
  resetAll();
});

test("collectToolCall: uses fallback field names", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.collectToolCall({
    message: { content: [{ type: "toolCall", toolCallId: "tc1", toolName: "search", input: { q: "test" } }] },
    toolResults: [{ id: "tc1", content: "plain" }]
  });
  assert.equal(sz.getPendingToolCalls().length, 1);
  assert.equal(sz.getPendingToolCalls()[0].id, "tc1");
  assert.equal(sz.getPendingToolCalls()[0].name, "search");
  assert.deepEqual(sz.getPendingToolCalls()[0].args, { q: "test" });
  assert.equal(sz.getPendingToolCalls()[0].result, "plain");
  resetAll();
});

// ── restoreSummariesFromBranch ──

test("restoreSummariesFromBranch: restores primary and global entries", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-primary-data",
      data: { toolCallIds: ["a", "b"], latestId: "b", text: "primary" } },
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["x", "y"], text: "global", timestamp: 2000 } },
    { type: "other", customType: "something" }
  ]);
  assert.equal(sz.getSummaries().length, 2);
  assert.equal(sz.getSummaries()[0].type, "primary");
  assert.equal(sz.getSummaries()[0].text, "primary");
  assert.equal(sz.getSummaries()[1].type, "global");
  assert.ok(sz.getSummaries()[1].collapsedIds.has("x"));
  resetAll();
});

test("restoreSummariesFromBranch: empty branch yields empty summaries", () => {
  const { sz, resetAll } = makeSummarizer();
  sz.restoreSummariesFromBranch([]);
  assert.equal(sz.getSummaries().length, 0);
});

test("restoreSummariesFromBranch: keeps only latest global summary", () => {
  const { sz } = makeSummarizer();
  sz.restoreSummariesFromBranch([
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["x1"], text: "old", timestamp: 1000 } },
    { type: "custom", customType: "context-prune-global-data",
      data: { collapsedIds: ["x2"], text: "new", timestamp: 2000 } }
  ]);

  const globals = sz.getSummaries().filter(s => s.type === "global");
  assert.equal(globals.length, 1);
  assert.equal(globals[0].text, "new");
});

