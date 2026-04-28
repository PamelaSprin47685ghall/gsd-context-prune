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

test("before_provider_request: only injects reasoning_content for assistant messages", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "gpt-4o", messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[0], false);
  assert.equal("reasoning_content" in result.messages[1], false);
  assert.equal(result.messages[2].reasoning_content, "");
  assert.equal("reasoning_content" in result.messages[2], true);
});

test("before_provider_request: skips reasoning_content for Anthropic/Claude models", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "claude-sonnet-4", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], false);
});

test("before_provider_request: skips reasoning_content when provider contains anthropic", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const result = events.before_provider_request({
    payload: { model: "some-model", provider: "anthropic", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ] }
  });
  assert.equal("reasoning_content" in result.messages[1], false);
});

test("before_provider_request: does not mutate original payload messages array", () => {
  const events = makePlugin();
  events.session_start({}, sessionCtx());
  const original = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" }
  ];
  const payload = { model: "gpt-4o", messages: original };
  events.before_provider_request({ payload });
  assert.equal("reasoning_content" in original[1], false);
});
