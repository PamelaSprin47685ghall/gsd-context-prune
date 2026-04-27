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

test("before_provider_request: injects HINTS into system prompt", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global-hint-content");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint-content");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = makePlugin();
    events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "You are a helpful assistant.\n\n## Subagent Model\n\nDone." },
          { role: "user", content: "hello" }
        ]
      }
    });
    assert.ok(result.messages[0].content.includes("[HINTS — Stable Guidance]"));
    assert.ok(result.messages[0].content.includes("global-hint-content"));
    assert.ok(result.messages[0].content.includes("project-hint-content"));
    assert.ok(result.messages[0].content.includes("You are a helpful assistant"));
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "system");
    assert.equal(result.messages[1].role, "user");
  });
})));

test("before_provider_request: idempotent — does not double-inject HINTS", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "persistent-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint-2");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = makePlugin();
    events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
    const r1 = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "msg 1" }
        ]
      }
    });
    const r2 = events.before_provider_request({
      payload: { model: "test",
        messages: r1.messages.map((m, i) =>
          i === r1.messages.length - 1
            ? { role: "user", content: "msg 2" }
            : m
        )
      }
    });
    const hintsCount = (r2.messages[0].content.match(/\[HINTS — Stable Guidance\]/g) || []).length;
    assert.equal(hintsCount, 1);
  });
})));

test("before_provider_request: always injects context_prune hint (even without user HINTS)", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = makePlugin();
    events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "Just system." },
          { role: "user", content: "hi" }
        ]
      }
    });
    assert.ok(result.messages[0].content.includes("[HINTS — Stable Guidance]"));
    assert.ok(result.messages[0].content.includes("Context Prune Discipline"));
  });
})));

test("before_provider_request: injects HINTS into array-based system content", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "array-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "arr-project");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = makePlugin();
    events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
    const result = events.before_provider_request({
      payload: { model: "test",
        input: [
          { role: "developer", content: [{ type: "text", text: "Dev instructions." }] },
          { role: "user", content: "hi" }
        ]
      }
    });
    assert.ok(result.input[0].content[1].text.includes("[HINTS — Stable Guidance]"));
    assert.ok(result.input[0].content[1].text.includes("array-hint"));
    assert.equal(result.input.length, 2);
  });
})));
