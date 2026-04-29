import test from "node:test";
import assert from "node:assert/strict";
import { makePlugin, sessionCtx } from "./helpers.mjs";

test("before_provider_request: preserves payload fields", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "test", store: false,
      messages: [
        { role: "system", content: "Static." },
        { role: "user", content: "hello" }
      ]
    }
  });
  assert.ok(result);
  assert.equal(result.model, "test");
  assert.equal(result.store, false);
});

test("before_provider_request — Responses: preserves payload fields and IDs", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "gpt-5", store: false,
      input: [
        { role: "system", content: "Static." },
        { role: "user", content: "hello" },
        { type: "message", role: "assistant", id: "msg_rnd", content: [] }
      ]
    }
  });
  assert.ok(result);
  assert.ok(result.input[0].content.includes("Static."));
  assert.equal(result.input[2].id, "msg_rnd");
});

test("before_provider_request — Responses: strips session-scoped prompt_cache_key", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "gpt-5", store: false,
      prompt_cache_key: "session_abc123",
      prompt_cache_retention: "24h",
      input: [
        { role: "system", content: "Static." },
        { role: "user", content: "hello" }
      ]
    }
  });
  assert.ok(result);
  assert.equal(result.prompt_cache_key, undefined);
  assert.ok(result.input);
});

test("before_provider_request — Messages API: preserves prompt_cache_key", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "claude", prompt_cache_key: "session_xyz",
      messages: [
        { role: "user", content: "hello" }
      ]
    }
  });
  assert.ok(result);
  assert.equal(result.prompt_cache_key, "session_xyz");
});

test("before_provider_request: injects reasoning_content when thinking is enabled and message has tool calls", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "deepseek-chat", reasoning_effort: "high", messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[0], true);
  assert.equal(result.messages[0].reasoning_content, "");
  assert.equal("reasoning_content" in result.messages[1], false);
  assert.equal("reasoning_content" in result.messages[2], true);
  assert.equal(result.messages[2].reasoning_content, "");
});

test("before_provider_request: injects reasoning_content for tool_use messages even without thinking flag", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "claude-sonnet-4", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read", input: {} }] }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], true);
  assert.equal(result.messages[1].reasoning_content, "");
});

test("before_provider_request: injects reasoning_content for all non-user messages", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "gpt-4o", provider: "anthropic", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], true);
  assert.equal(result.messages[1].reasoning_content, "");
});

test("before_provider_request: injects reasoning_content for Anthropic format with tool_use when thinking enabled", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "deep thought", signature: "sig_abc" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tu_1", name: "read", input: {} }
      ] }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], true);
  assert.equal(result.messages[1].reasoning_content, "deep thought");
});

test("before_provider_request: injects empty reasoning_content for Anthropic format with tool_use but no thinking blocks", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [
        { type: "text", text: "no thinking" },
        { type: "tool_use", id: "tu_1", name: "read", input: {} }
      ] }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], true);
  assert.equal(result.messages[1].reasoning_content, "");
});

test("before_provider_request: skips messages that already have reasoning_content", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "deepseek-chat", reasoning_effort: "high", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c_1", type: "function", function: { name: "x", arguments: "{}" } }], reasoning_content: "already there" }
    ] }
  });
  assert.equal(result.messages[0].reasoning_content, "already there");
});

test("before_provider_request: does not mutate original payload messages array", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const original = [
    { role: "system", content: "sys" },
    { role: "assistant", content: null, tool_calls: [{ id: "c_1", type: "function", function: { name: "x", arguments: "{}" } }] }
  ];
  const payload = { model: "deepseek-chat", reasoning_effort: "high", messages: original };
  events.before_provider_request({ payload });
  assert.equal("reasoning_content" in original[1], false);
});
