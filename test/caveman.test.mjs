import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCavemanBlock, buildCavemanReminder } from "../src/caveman.js";
import { withTmp, withEnv } from "./helpers.mjs";
import contextPrunePlugin, { setCodebaseDir } from "../index.js";

const makePlugin = () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });
  return events;
};

test("buildCavemanBlock: returns marked content", () => {
  const block = buildCavemanBlock();
  assert.ok(block.includes("[思维与表达]"));
  assert.ok(block.includes("规则"));
  assert.ok(block.includes("极简中文"));
});

test("context: appends short reminder as last system message", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.context({
      messages: [
        { role: "system", content: "Static system." },
        { role: "user", content: "hello" }
      ]
    });
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "system");
    assert.ok(last.content.includes("思考/回复必用极简中文"));
    assert.ok(last.content.includes("问斩"));
    // first system message untouched (prefix cache preserved)
    assert.equal(result.messages[0].content, "Static system.");
  });
}));

test("context: short reminder includes file listing before it", () => withTmp(dir => {
  mkdirSync(join(dir, ".gsd"));
  writeFileSync(join(dir, "test.txt"), "data");
  setCodebaseDir(dir);
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.context({
      messages: [
        { role: "user", content: "hi" }
      ]
    });
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "system");
    assert.ok(last.content.includes("$ du -hxd1"));
    assert.ok(last.content.includes("test.txt"));
    assert.ok(last.content.includes("思考/回复必用极简中文"));
    // listing before reminder
    assert.ok(last.content.indexOf("$ du -hxd1") < last.content.indexOf("<think>"));
  });
}));

test("context: only reminder when no listing available", () => withTmp(dir => {
  setCodebaseDir("/nonexistent");
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.context({
      messages: [
        { role: "user", content: "hi" }
      ]
    });
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "system");
    assert.ok(last.content.includes("思考/回复必用极简中文"));
    assert.ok(!last.content.includes("$ du -hxd1"));
  });
}));

test("context: first system message left untouched (prefix cache)", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.context({
      messages: [
        { role: "system", content: "Original system prompt." },
        { role: "user", content: "hello" }
      ]
    });
    assert.equal(result.messages[0].content, "Original system prompt.");
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "system");
    assert.ok(last.content.includes("思考/回复必用极简中文"));
    assert.equal(result.messages.length, 3);
  });
}));

// ── Reminder tests ──────────────────────────────────

test("buildCavemanReminder: returns formatted reminder", () => {
  const reminder = buildCavemanReminder();
  assert.ok(reminder.includes("极简中文"));
  assert.ok(reminder.includes("问斩"));
});
