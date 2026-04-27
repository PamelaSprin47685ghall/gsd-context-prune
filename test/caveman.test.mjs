import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCavemanBlock, injectCaveman, injectCavemanDemonstration, DEMO_USER_PROMPT } from "../src/caveman.js";
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

// ── Demonstration turn tests ────────────────────────

test("injectCavemanDemonstration: injects demo turn before first user message", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "real question" }
  ];
  const result = injectCavemanDemonstration(messages);
  assert.equal(result.length, 4);
  assert.equal(result[0].role, "system");
  assert.equal(result[1].role, "user");
  assert.equal(result[1].content, DEMO_USER_PROMPT);
  assert.equal(result[2].role, "assistant");
  assert.ok(result[2].reasoning_content);
  assert.ok(result[2].content);
  assert.equal(result[3].role, "user");
  assert.equal(result[3].content, "real question");
});

test("injectCavemanDemonstration: skips when assistant already exists (non-first-turn)", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
    { role: "user", content: "q2" }
  ];
  const result = injectCavemanDemonstration(messages);
  assert.equal(result, messages);
});

test("injectCavemanDemonstration: idempotent — skips when demo already injected", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: DEMO_USER_PROMPT },
    { role: "assistant", content: "demo", reasoning_content: "thinking demo" },
    { role: "user", content: "real q" }
  ];
  const result = injectCavemanDemonstration(messages);
  assert.equal(result, messages);
});

test("injectCavemanDemonstration: skips when no user message", () => {
  const messages = [
    { role: "system", content: "sys" }
  ];
  const result = injectCavemanDemonstration(messages);
  assert.equal(result, messages);
});

test("before_provider_request: demo turn is injected in fresh conversations", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "first question" }
        ]
      }
    });
    // 4 messages: system, demo user, demo assistant, original user
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[1].content, DEMO_USER_PROMPT);
    assert.equal(result.messages[2].role, "assistant");
    assert.ok(result.messages[2].reasoning_content);
    assert.ok(result.messages[2].content);
    assert.equal(result.messages[3].content, "first question");
  });
}));

test("before_provider_request: demo not injected on subsequent turns", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    // First turn — demo injected
    const r1 = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "msg 1" }
        ]
      }
    });
    // Second turn — simulate next request (replace last user msg + add assistant)
    const r2Input = [
      ...r1.messages.slice(0, -1),
      { role: "assistant", content: "earlier response" },
      { role: "user", content: "msg 2" }
    ];
    const r2 = events.before_provider_request({
      payload: { model: "test", messages: r2Input }
    });
    // No additional injection — same length as input
    assert.equal(r2.messages.length, r2Input.length);
  });
}));

test("before_provider_request: demo assistant has reasoning_content and content", () => withTmp(dir => {
  const events = makePlugin();
  events.session_start({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events.before_provider_request({
      payload: { model: "test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" }
        ]
      }
    });
    const demo = result.messages[2];
    assert.ok(demo.reasoning_content.includes("CAVEMAN"));
    assert.ok(demo.reasoning_content.includes("极简"));
    assert.ok(demo.reasoning_content.includes("违CAVEMAN则"));
    assert.ok(demo.content.includes("确然"));
    assert.ok(demo.content.includes("已改"));
  });
}));
