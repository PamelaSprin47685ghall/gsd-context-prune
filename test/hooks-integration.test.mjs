import test from "node:test";
import assert from "node:assert/strict";
import contextPrunePlugin from "../index.js";
import { makePlugin, sessionCtx } from "./helpers.mjs";

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
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());

  events.session_switch({}, ctxWithBranch(branchWithPrimary()));
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
});

test("integration: session_fork restores summaries and resets pending tool calls", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());

  events.session_fork({}, ctxWithBranch(branchWithPrimary()));
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
});

test("integration: session_tree restores summaries and resets pending tool calls", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, sessionCtx());

  events.session_tree({}, ctxWithBranch(branchWithPrimary()));
  const result = events.context({
    messages: [
      { role: "toolResult", toolCallId: "call2", content: "raw" }
    ]
  });
  assert.ok(result.messages[0].content[0].text.includes("test summary"));
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

test("integration: no compact on error stop", () => {
  const calls = [];
  const pi = {
    on: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    sendUserMessage: (msg) => calls.push(msg)
  };
  const events = {};
  pi.on = (e, cb) => { events[e] = cb; };
  contextPrunePlugin(pi);
  events.session_start({}, sessionCtx());
  events.context({ messages: [{ role: "user", content: "hi" }] });
  events.turn_end({ message: { stopReason: "error" } }, {
    getContextUsage: () => ({ tokens: 250, contextWindow: 300, percent: 83.33 }),
    ui: { notify: () => {} }
  });
  assert.equal(calls.length, 0);
});

test("integration: turn_end without tool calls sends /compact but no retryLastTurn", () => {
  const calls = [];
  const pi = {
    on: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    sendUserMessage: (msg) => calls.push({ type: "sendUserMessage", msg }),
    retryLastTurn: () => calls.push({ type: "retryLastTurn" })
  };
  const events = {};
  pi.on = (e, cb) => { events[e] = cb; };
  contextPrunePlugin(pi);
  events.session_start({}, sessionCtx());
  events.context({ messages: [{ role: "user", content: "hi" }] });
  events.turn_end({ message: { content: [{ type: "text", text: "done" }], stopReason: "stop" } }, {
    getContextUsage: () => ({ tokens: 250, contextWindow: 300, percent: 83.33 }),
    ui: { notify: () => {} }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "sendUserMessage");
  assert.equal(calls[0].msg, "/compact");
});
test("integration: sends /compact at >66% context usage and retries turn if agent continues", async () => {
  const calls = [];
  const pi = {
    on: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    sendUserMessage: (msg) => calls.push({ type: "sendUserMessage", msg }),
    retryLastTurn: () => calls.push({ type: "retryLastTurn" })
  };
  const handlers = {};
  pi.on = (e, cb) => { handlers[e] = cb; };
  contextPrunePlugin(pi);
  handlers.session_start({}, {
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [] }
  });
  handlers.context({ messages: [{ role: "user", content: "hi", timestamp: 1000 }, { role: "assistant", content: "ok", timestamp: 1001 }] });
  const ctx = {
    getContextUsage: () => ({ tokens: 262144, contextWindow: 300000, percent: 87.38 }),
    modelRegistry: { find: () => null }, model: "fake",
    ui: { notify: () => {} }
  };
  handlers.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }], stopReason: "stop" },
    toolResults: [{ toolCallId: "tc1", content: "result" }]
  }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "sendUserMessage");
  assert.equal(calls[0].msg, "/compact");
});

// ── Input auto-trigger ──

test("integration: input triggers primary summary when tool calls pending", async () => {
  const pi = { on: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {} };
  const handlers = {}, notes = [];
  pi.on = (e, cb) => { handlers[e] = cb; };
  contextPrunePlugin(pi);
  handlers.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

  // Simulate a turn with tool calls
  handlers.turn_end({
    message: { content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }] },
    toolResults: [{ toolCallId: "tc1", content: [{ type: "text", text: "file content" }] }]
  }, sessionCtx());

  // User sends new message → should trigger primary summary
  const result = handlers.input({ text: "continue", source: "interactive" }, {
    ui: { notify: (m) => notes.push(m) },
    model: {},
    modelRegistry: { find: () => null }
  });
  assert.deepEqual(result, { action: "continue" });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(notes.some(n => n.includes("初级精简") || n.includes("正在进行")));
});

test("integration: input does not trigger when no pending tool calls", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const notes = [];
  const result = events.input({ text: "hello", source: "interactive" }, {
    ui: { notify: (m) => notes.push(m) },
    model: {}
  });
  assert.deepEqual(result, { action: "continue" });
  assert.equal(notes.length, 0);
});

test("integration: input with source=extension also triggers", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  events.turn_end({
    message: { content: [{ type: "toolCall", id: "ext1", name: "search", arguments: {} }] },
    toolResults: [{ toolCallId: "ext1", content: "hits" }]
  }, sessionCtx());
  const notes = [];
  events.input({ text: "from extension", source: "extension" }, {
    ui: { notify: (m) => notes.push(m) },
    model: {}
  });
  assert.ok(notes.some(n => n.includes("初级精简") || n.includes("正在进行")));
});
