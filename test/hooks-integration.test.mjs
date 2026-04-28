import test from "node:test";
import assert from "node:assert/strict";
import contextPrunePlugin from "../index.js";

const makePlugin = () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });
  return events;
};

test("integration: session_start restores summaries, context projects them", () => {
  const events = makePlugin();
  events.session_start({}, {
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [
      { type: "custom", customType: "context-prune-primary-data",
        data: { toolCallIds: ["call1", "call2"], latestId: "call2", text: "test summary" } }
    ]}
  });
  const result = events.context({
    messages: [
      { role: "user", content: "test" },
      { role: "toolResult", toolCallId: "call1", content: "raw 1" },
      { role: "toolResult", toolCallId: "call2", content: "raw 2" },
      { role: "toolResult", toolCallId: "call3", content: "raw 3" }
    ]
  });
  // +1 for appended system(reminder+listing) message
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].toolCallId, "call1");
  assert.deepEqual(result.messages[1].content, []);
  assert.equal(result.messages[2].toolCallId, "call2");
  assert.ok(result.messages[2].content[0].text.includes("test summary"));
  assert.equal(result.messages[3].toolCallId, "call3");
  assert.equal(result.messages[3].content, "raw 3");
  // last message is the user reminder
  assert.equal(result.messages[4].role, "user");
  assert.ok(result.messages[4].content.includes("思考/回复必用极简中文"));
});

test("integration: context hook preserves one-shot pattern (no extra assistant msgs)", () => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  const result = events.context({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "task 1" },
      { role: "user", content: "task 2" }
    ]
  });
  assert.equal(result.messages.filter(m => m.role === "assistant").length, 0);
  // +1 for appended system(reminder) message
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[3].role, "user");
  assert.ok(result.messages[3].content.includes("思考/回复必用极简中文"));
});

test("integration: no global summary on error stop", () => {
  const events = {}, notes = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {},
    appendEntry: () => {}
  });
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  events.context({ messages: [{ role: "user", content: "hi" }] });
  events.turn_end({ message: { stopReason: "error" } }, {
    getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }),
    ui: { notify: m => notes.push(m) }
  });
  assert.ok(!notes.some(n => n.includes("高级精简")));
});
