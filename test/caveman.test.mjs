import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCavemanBlock, injectCaveman, buildCavemanReminder } from "../src/caveman.js";
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
  assert.ok(block.includes("[CAVEMAN — 极简思维与表达]"));
  assert.ok(block.includes("规则"));
  assert.ok(block.includes("自动清朗"));
  assert.ok(block.includes("自动清朗"));
});

test("injectCaveman: prepends to string system content", () => {
  const messages = [
    { role: "system", content: "Original system prompt." },
    { role: "user", content: "hello" }
  ];
  const result = injectCaveman(messages);
  assert.ok(result[0].content.startsWith("[CAVEMAN — 极简思维与表达]"));
  assert.ok(result[0].content.includes("Original system prompt."));
  assert.equal(result.length, 2);
});

test("injectCaveman: prepends to array system content", () => {
  const messages = [
    { role: "developer", content: [{ type: "text", text: "Dev instructions." }] },
    { role: "user", content: "hi" }
  ];
  const result = injectCaveman(messages);
  assert.ok(result[0].content[0].text.startsWith("[CAVEMAN — 极简思维与表达]"));
  assert.equal(result[0].content[1].text, "Dev instructions.");
  assert.equal(result.length, 2);
});

test("injectCaveman: idempotent — does not double-inject", () => {
  const messages = [
    { role: "system", content: "[CAVEMAN — 极简思维与表达]\n\nRules.\n\nOriginal." },
    { role: "user", content: "hi" }
  ];
  const result = injectCaveman(messages);
  assert.equal(result[0].content, messages[0].content);
  assert.equal(result, messages);
});

test("injectCaveman: does not touch non-system messages", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" }
  ];
  const result = injectCaveman(messages);
  assert.equal(result, messages);
});

test("before_provider_request: caveman block appears in system prompt", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "Static system." },
          { role: "user", content: "hello" }
        ]
      }
    });
    assert.ok(result.messages[0].content.includes("[CAVEMAN — 极简思维与表达]"));
    assert.ok(result.messages[0].content.includes("规则"));
    assert.ok(result.messages[0].content.includes("缩写"));
  });
}));

test("before_provider_request: caveman + HINTS both present", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "Base." },
          { role: "user", content: "hi" }
        ]
      }
    });
    const idxCaveman = result.messages[0].content.indexOf("[CAVEMAN — 极简思维与表达]");
    const idxHints = result.messages[0].content.indexOf("[HINTS — Stable Guidance]");
    assert.ok(idxCaveman !== -1);
    assert.ok(idxHints !== -1);
    assert.ok(idxCaveman < idxHints, "caveman block should appear before HINTS block");
  });
}));

// ── Reminder tests ──────────────────────────────────

test("buildCavemanReminder: returns formatted reminder", () => {
  const reminder = buildCavemanReminder();
  assert.ok(reminder.includes("CAVEMAN"));
  assert.ok(reminder.includes("极简中文"));
  assert.ok(reminder.includes("问斩"));
  assert.ok(reminder.includes("断头"));
});
