import test from "node:test";
import assert from "node:assert/strict";
import contextPrunePlugin from "../index.js";
import { withTmp, withEnv } from "./helpers.mjs";

const makePlugin = () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });
  return events;
};

test("before_provider_request: normalizes null content to empty string", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "Static." },
          { role: "user", content: null },
          { role: "assistant", content: null }
        ]
      }
    });
    assert.equal(result.messages[1].content, "");
    assert.equal(result.messages[2].content, "");
  });
}));

test("before_provider_request: adds reasoning_content when reasoning_effort is set", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const payload = { model: "deepseek-v4", reasoning_effort: "low",
      messages: [
        { role: "system", content: "Static." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ]
    };
    const result = events.before_provider_request({ payload });
    assert.equal(result.messages[2].reasoning_content, "");
    assert.equal(result.messages[1].reasoning_content, undefined);
    assert.equal(payload.messages[2].reasoning_content, undefined);
  });
}));
