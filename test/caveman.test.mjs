import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCavemanBlock, buildCavemanReminder, injectCavemanBlock } from "../src/caveman.js";
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

test("context: appends short reminder as last user message", () => withTmp(dir => {
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
    assert.equal(last.role, "user");
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
    assert.equal(last.role, "user");
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
    assert.equal(last.role, "user");
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
    assert.equal(last.role, "user");
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

// ── injectCavemanBlock tests ────────────────────────

test("injectCavemanBlock: prepends block to system message", () => {
  const result = injectCavemanBlock([
    { role: "system", content: "Original system." },
    { role: "user", content: "hi" }
  ]);
  assert.ok(result[0].content.startsWith("[思维与表达]"));
  assert.ok(result[0].content.includes("极简中文"));
  assert.ok(result[0].content.endsWith("Original system."));
  assert.equal(result[1].content, "hi");
});

test("injectCavemanBlock: idempotent — does not double-inject", () => {
  const first = injectCavemanBlock([
    { role: "system", content: "Original." }
  ]);
  assert.ok(first[0].content.includes("[思维与表达]"));
  const second = injectCavemanBlock(first);
  // count occurrences — should be exactly one
  assert.equal(second[0].content.split("[思维与表达]").length, 2);
});

test("injectCavemanBlock: skips non-system messages", () => {
  const result = injectCavemanBlock([
    { role: "user", content: "hello" },
    { role: "assistant", content: "bye" }
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, "hello");
});

test("injectCavemanBlock: handles array-based content", () => {
  const result = injectCavemanBlock([
    { role: "developer", content: [{ type: "text", text: "Dev prompt." }] }
  ]);
  assert.ok(result[0].content[0].text.startsWith("[思维与表达]"));
  assert.ok(result[0].content[0].text.includes("极简中文"));
});

test("injectCavemanBlock: returns unchanged when no system/developer", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.strictEqual(injectCavemanBlock(messages), messages);
});
