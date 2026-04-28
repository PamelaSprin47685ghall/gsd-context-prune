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
