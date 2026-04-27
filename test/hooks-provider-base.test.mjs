import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contextPrunePlugin, { setCodebaseDir } from "../index.js";
import { withTmp, withEnv } from "./helpers.mjs";

const makePlugin = () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });
  return events;
};

test("before_provider_request — Chat: strips CODEBASE, no HINTS injection without HINTS.md", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test", store: false,
        messages: [
          { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Subagent Model\n\nDone." },
          { role: "user", content: "hello" }
        ]
      }
    });
    assert.ok(result);
    assert.ok(!result.messages[0].content.includes("PROJECT CODEBASE"));
    assert.ok(result.messages[0].content.includes("Static."));
    assert.ok(result.messages[0].content.includes("## Subagent Model"));
    assert.ok(!result.messages[0].content.includes("[HINTS — Stable Guidance]"));
    assert.equal(result.model, "test");
    assert.equal(result.store, false);
  });
}));

test("before_provider_request — Responses: strips CODEBASE, injects HINTS, stabilizes IDs", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
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
    assert.equal(result.input[2].id, undefined);
  });
}));

test("before_provider_request — Responses: works without CODEBASE", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "gpt-5", store: false,
        input: [
          { role: "system", content: "No CODEBASE here." },
          { role: "user", content: "hi" },
          { type: "message", role: "assistant", id: "msg_xyz", content: [] }
        ]
      }
    });
    assert.ok(result);
    assert.equal(result.input[2].id, undefined);
  });
}));
