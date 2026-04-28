import test from "node:test";
import assert from "node:assert/strict";
import contextPrunePlugin from "../index.js";
import { makePlugin, sessionCtx } from "./helpers.mjs";
import { getPendingToolCalls, resetPendingToolCalls } from "../src/summary.js";

const branchWithPrimary = () => [
  { type: "custom", customType: "context-prune-primary-data",
    data: { toolCallIds: ["call1", "call2"], latestId: "call2", text: "test summary" } }
];

const ctxWithBranch = (branch) => ({
  ui: { notify: () => {} },
  sessionManager: { getBranch: () => branch }
});

test("integration: session_start restores summaries, context projects them", () => {
  const events = makePlugin();
  events.session_start({}, ctxWithBranch(branchWithPrimary()));
  const result = events.context({
    messages: [
      { role: "user", content: "test" },
      { role: "toolResult", toolCallId: "call1", content: "raw 1" },
      { role: "toolResult", toolCallId: "call2", content: "raw 2" },
      { role: "toolResult", toolCallId: "call3", content: "raw 3" }
    ]
  });
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].toolCallId, "call1");
  assert.deepEqual(result.messages[1].content, []);
  assert.equal(result.messages[2].toolCallId, "call2");
  assert.ok(result.messages[2].content[0].text.includes("test summary"));
  assert.equal(result.messages[3].toolCallId, "call3");
  assert.equal(result.messages[3].content, "raw 3");
});

test("integration: session_switch restores summaries and resets pending tool calls", () => {
  resetPendingToolCalls();
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());
  assert.equal(getPendingToolCalls().length, 1);

  events.session_switch({}, ctxWithBranch(branchWithPrimary()));
  assert.equal(getPendingToolCalls().length, 0);
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
  resetPendingToolCalls();
});

test("integration: session_fork restores summaries and resets pending tool calls", () => {
  resetPendingToolCalls();
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());
  assert.equal(getPendingToolCalls().length, 1);

  events.session_fork({}, ctxWithBranch(branchWithPrimary()));
  assert.equal(getPendingToolCalls().length, 0);
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
  resetPendingToolCalls();
});

test("integration: session_tree restores summaries and resets pending tool calls", () => {
  resetPendingToolCalls();
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());
  assert.equal(getPendingToolCalls().length, 1);

  events.session_tree({}, ctxWithBranch(branchWithPrimary()));
  assert.equal(getPendingToolCalls().length, 0);
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
  resetPendingToolCalls();
});

test("integration: context hook preserves one-shot pattern (no extra assistant msgs)", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.context({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "task 1" },
      { role: "user", content: "task 2" }
    ]
  });
  assert.equal(result.messages.filter(m => m.role === "assistant").length, 0);
});

test("integration: migrates reasoning_content to thinking block", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.context({
    messages: [
      { role: "assistant", content: [], reasoning_content: "deep thought" }
    ]
  });
  assert.equal(result.messages[0].content[0].type, "thinking");
  assert.equal(result.messages[0].content[0].thinking, "deep thought");
  assert.equal(result.messages[0].reasoning_content, undefined);
});

test("integration: no global summary on error stop", () => {
  const events = {}, notes = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {},
    appendEntry: () => {}
  });
  events.session_start({}, sessionCtx());
  events.context({ messages: [{ role: "user", content: "hi" }] });
  events.turn_end({ message: { stopReason: "error" } }, {
    getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }),
    ui: { notify: m => notes.push(m) }
  });
  assert.ok(!notes.some(n => n.includes("高级精简")));
});
