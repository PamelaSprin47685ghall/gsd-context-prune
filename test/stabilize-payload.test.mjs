import test from "node:test";
import assert from "node:assert/strict";
import { stabilizePayload, setCodebaseDir } from "../index.js";
import { withTmp } from "./helpers.mjs";

test("stabilizePayload: Chat — strips CODEBASE, preserves messages", () => {
  const event = {
    payload: {
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful.\n\n[PROJECT CODEBASE — File structure (generated 2026-04-27T09:32:03Z)]\n- file.js\n\n## Subagent Model\n\nDone." },
        { role: "user", content: "what is the weather?" },
        { role: "assistant", content: "Let me check." },
        { role: "user", content: "tell me more" }
      ],
      stream: true, store: false
    }
  };
  const r = stabilizePayload(event);
  assert.ok(!r.messages[0].content.includes("PROJECT CODEBASE"));
  assert.ok(r.messages[0].content.includes("## Subagent Model"));
  // no longer injects system-notification into user messages
  assert.ok(!r.messages[3].content.includes("<system-notification>"));
  assert.ok(event.payload.messages[0].content.includes("PROJECT CODEBASE"));
});

test("stabilizePayload: Responses — strips CODEBASE, stabilizes, no injection", () => {
  const event = {
    payload: {
      model: "gpt-5",
      input: [
        { type: "message", role: "system", content: [{ type: "text", text: "You are helpful.\n\n[PROJECT CODEBASE — File structure]\n- file.js\n\n## Subagent Model\n\nDone." }] },
        { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
        { type: "message", role: "assistant", id: "msg_rnd", content: [] },
        { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
        { type: "function_call_output", call_id: "call_rnd", output: "ok" },
        { type: "message", role: "user", content: [{ type: "text", text: "tell me more" }] }
      ],
      store: false
    }
  };
  const r = stabilizePayload(event);
  assert.ok(!r.input[0].content[0].text.includes("PROJECT CODEBASE"));
  // no longer injects system-notification
  assert.ok(!r.input[5].content.some(c => c.text?.includes("<system-notification>")));
  assert.equal(r.input[3].id, undefined);
  assert.equal(r.input[3].call_id, undefined);
  assert.equal(r.input[4].call_id, undefined);
});

test("stabilizePayload: append-only — no injection in any round", () => {
  const event = {
    payload: {
      model: "test",
      messages: [
        { role: "system", content: "Static system.\n\n[PROJECT CODEBASE — File structure (generated 2026-04-27T09:32:03Z)]\n- file.js\n\n## Subagent Model\n\nDo work." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi." },
        { role: "user", content: "tell me more" },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "more details" }
      ]
    }
  };
  const r = stabilizePayload(event);
  const count = r.messages.reduce((s, m) =>
    s + (typeof m.content === "string" ? (m.content.match(/<system-notification>/g) || []).length : 0), 0);
  assert.equal(count, 0);
});

test("stabilizePayload: no notification injected without CODEBASE either", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n## Subagent Model\n\nDone." },
    { role: "user", content: "hello" }
  ]}});
  assert.ok(r);
  assert.ok(!r.messages[1].content.includes("<system-notification>"));
  assert.ok(r.messages[0].content.includes("Static."));
});

test("stabilizePayload: handles array content user messages", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- file.js\n\n## Subagent Model\n\nInstructions." },
    { role: "user", content: [{ type: "text", text: "hello" }] }
  ]}});
  assert.ok(r);
  assert.ok(!r.messages[1].content.some(c => c.text?.includes("<system-notification>")));
});

test("stabilizePayload: preserves other payload fields", () => {
  const r = stabilizePayload({ payload: {
    model: "deepseek-v4", stream: true, max_completion_tokens: 8192,
    tools: [{ type: "function", function: { name: "test" } }],
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## Subagent Model\n\nDone." },
      { role: "user", content: "hi" }
    ]
  }});
  assert.equal(r.model, "deepseek-v4");
  assert.equal(r.stream, true);
  assert.equal(r.max_completion_tokens, 8192);
  assert.equal(r.reasoning_effort, "high");
  assert.equal(r.tools[0].function.name, "test");
});
