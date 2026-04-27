import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextPrunePlugin, { setCodebaseDir } from "../index.js";

// ===========================================================================
// Helpers
// ===========================================================================

const withTmp = (fn) => {
  const d = mkdtempSync(join(tmpdir(), "gsd-"));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

const withEnv = (k, v, fn) => {
  const o = process.env[k];
  v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return fn(); } finally { o === undefined ? delete process.env[k] : process.env[k] = o; }
};

// ===========================================================================
// Plugin registration
// ===========================================================================

test("registers hooks, tool, and command", () => {
  const events = {}, tools = [], commands = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: t => tools.push(t),
    registerCommand: (n, o) => commands.push({ name: n, options: o })
  });
  assert.equal(typeof events.before_provider_request, "function");
  assert.equal(typeof events.session_start, "function");
  assert.equal(typeof events.context, "function");
  assert.equal(typeof events.turn_end, "function");
  assert.equal(events.before_agent_start, undefined);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "context_prune");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "pruner");
});

// ===========================================================================
// before_provider_request — CODEBASE strip, HINTS inject, IDs
// ===========================================================================

test("before_provider_request — Chat: strips CODEBASE, no HINTS injection without HINTS.md", () => withTmp(dir => {
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
  events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events["before_provider_request"]({
      payload: { model: "test", store: false,
        messages: [
          { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Subagent Model\n\nDone." },
          { role: "user", content: "hello" }
        ]
      }
    });
    assert.ok(result);
    // CODEBASE stripped from system message
    assert.ok(!result.messages[0].content.includes("PROJECT CODEBASE"));
    assert.ok(result.messages[0].content.includes("Static."));
    assert.ok(result.messages[0].content.includes("## Subagent Model"));
    // No HINTS.md in tmp → no injection
    assert.ok(!result.messages[0].content.includes("[HINTS — Stable Guidance]"));
    // Original payload fields preserved
    assert.equal(result.model, "test");
    assert.equal(result.store, false);
  });
}));

test("before_provider_request — Responses: strips CODEBASE, injects HINTS, stabilizes IDs", () => withTmp(dir => {
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
  events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events["before_provider_request"]({
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
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
  events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  withEnv("GSD_HOME", dir, () => {
    const result = events["before_provider_request"]({
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

// ===========================================================================
// before_provider_request — HINTS injection
// ===========================================================================

test("before_provider_request: injects HINTS into system prompt", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global-hint-content");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint-content");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = {};
    contextPrunePlugin({
      on: (e, cb) => { events[e] = cb; },
      registerTool: () => {}, registerCommand: () => {}
    });
    events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

    const result = events["before_provider_request"]({
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
  });
})));

test("before_provider_request: idempotent — does not double-inject HINTS", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "persistent-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint-2");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = {};
    contextPrunePlugin({
      on: (e, cb) => { events[e] = cb; },
      registerTool: () => {}, registerCommand: () => {}
    });
    events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

    // 第一轮：HINTS 注入
    const r1 = events["before_provider_request"]({
      payload: { model: "test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "msg 1" }
        ]
      }
    });
    // 第二轮：system 已有 HINTS 标记 → 跳过注入
    const r2 = events["before_provider_request"]({
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

test("before_provider_request: skips injection when no HINTS files exist", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = {};
    contextPrunePlugin({
      on: (e, cb) => { events[e] = cb; },
      registerTool: () => {}, registerCommand: () => {}
    });
    events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

    const result = events["before_provider_request"]({
      payload: { model: "test",
        messages: [
          { role: "system", content: "Just system." },
          { role: "user", content: "hi" }
        ]
      }
    });
    assert.ok(!result.messages[0].content.includes("[HINTS — Stable Guidance]"));
  });
})));

test("before_provider_request: injects HINTS into array-based system content", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "array-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "arr-project");
  withEnv("GSD_HOME", gDir, () => {
    setCodebaseDir(pDir);
    const events = {};
    contextPrunePlugin({
      on: (e, cb) => { events[e] = cb; },
      registerTool: () => {}, registerCommand: () => {}
    });
    events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

    const result = events["before_provider_request"]({
      payload: { model: "test",
        input: [
          { role: "developer", content: [{ type: "text", text: "Dev instructions." }] },
          { role: "user", content: "hi" }
        ]
      }
    });
    assert.ok(result.input[0].content[0].text.includes("[HINTS — Stable Guidance]"));
    assert.ok(result.input[0].content[0].text.includes("array-hint"));
    assert.equal(result.input.length, 2);
  });
})));

// ===========================================================================
// Integration — session persistence + context projection
// ===========================================================================

test("integration: session_start restores summaries, context projects them", () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });

  events["session_start"]({}, {
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [
      { type: "custom", customType: "context-prune-primary-data", data: { toolCallIds: ["call1", "call2"], latestId: "call2", text: "test summary" } }
    ]}
  });

  const result = events["context"]({
    messages: [
      { role: "user", content: "test" },
      { role: "toolResult", toolCallId: "call1", content: "raw 1" },
      { role: "toolResult", toolCallId: "call2", content: "raw 2" },
      { role: "toolResult", toolCallId: "call3", content: "raw 3" }
    ]
  });

  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].role, "user");
  // call1 在折叠集内但不是 latest → content 零字节
  assert.equal(result.messages[1].toolCallId, "call1");
  assert.deepEqual(result.messages[1].content, []);
  // call2 是 latest → content 替换为摘要（role 保持 toolResult，时序不乱）
  assert.equal(result.messages[2].toolCallId, "call2");
  assert.ok(result.messages[2].content[0].text.includes("test summary"));
  // call3 不在折叠集 → 不变
  assert.equal(result.messages[3].toolCallId, "call3");
  assert.equal(result.messages[3].content, "raw 3");
});

test("integration: context hook preserves one-shot pattern (no extra assistant msgs)", () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });

  events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });

  const result = events["context"]({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "task 1" },
      { role: "user", content: "task 2" }
    ]
  });

  assert.equal(result.messages.filter(m => m.role === "assistant").length, 0);
  assert.equal(result.messages.length, 3);
});

test("integration: no global summary on error stop", () => {
  const events = {}, notes = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {},
    appendEntry: () => {}
  });

  events["session_start"]({}, { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } });
  events["context"]({ messages: [{ role: "user", content: "hi" }] });

  events["turn_end"]({ message: { stopReason: "error" } }, {
    getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }),
    ui: { notify: m => notes.push(m) }
  });

  assert.ok(!notes.some(n => n.includes("高级精简")));
});
