import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextPrunePlugin, {
  loadHintSources,
  buildHintsBlock,
  stabilizePayload,
  stabilizeIds,
  stripCodebase,
  generateFileListing,
  setCodebaseDir,
  projectMessages
} from "./index.js";

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
// HINTS
// ===========================================================================

test("loadHintSources: prefers .gsd/HINTS.md over root", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global\n");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project\n");
  writeFileSync(join(pDir, "HINTS.md"), "root\n");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 2);
    assert.equal(s[0].content, "global");
    assert.equal(s[1].content, "project");
  });
})));

test("loadHintSources: falls back to root HINTS.md", () => withTmp(pDir => withTmp(gDir => {
  writeFileSync(join(pDir, "HINTS.md"), "root");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 1);
    assert.equal(s[0].content, "root");
  });
})));

test("loadHintSources: returns empty when no hints", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => assert.equal(loadHintSources(pDir).length, 0));
})));

test("buildHintsBlock: returns empty string when no hints", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => assert.equal(buildHintsBlock(pDir), ""));
})));

test("buildHintsBlock: formats hints block", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint");
  withEnv("GSD_HOME", gDir, () => {
    const r = buildHintsBlock(pDir);
    assert.ok(r.includes("[HINTS — Stable Guidance]"));
    assert.ok(r.includes("global-hint"));
    assert.ok(r.includes("project-hint"));
  });
})));

// ===========================================================================
// stripCodebase
// ===========================================================================

test("stripCodebase: strips CODEBASE block between markers", () => {
  const text = "You are helpful.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## Subagent Model\n\nDone.";
  const r = stripCodebase(text);
  assert.ok(r);
  assert.ok(!r.stable.includes("PROJECT CODEBASE"));
  assert.ok(r.stable.includes("You are helpful"));
  assert.ok(r.stable.includes("## Subagent Model"));
  assert.ok(r.dynamic.includes("app.js"));
});

test("stripCodebase: returns null when no CODEBASE", () => {
  assert.equal(stripCodebase("Just text."), null);
});

test("stripCodebase: handles missing boundary (partial CODEBASE)", () => {
  const text = "Start.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\nNo boundary after this.";
  assert.equal(stripCodebase(text), null);
});

// ===========================================================================
// stabilizePayload — pipeline: strip → inject → key → IDs
// ===========================================================================

test("stabilizePayload: Chat — strips CODEBASE, injects to last user", () => {
  const event = {
    payload: {
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful.\n\n[PROJECT CODEBASE — File structure (generated 2026-04-27T09:32:03Z)]\n- file.js\n\n## Subagent Model\n\nDone." },
        { role: "user", content: "what is the weather?" },
        { role: "assistant", content: "Let me check." },
        { role: "user", content: "tell me more" }
      ],
      stream: true, store: false
    }
  };
  const r = stabilizePayload(event);
  assert.ok(!r.messages[0].content.includes("PROJECT CODEBASE"));
  assert.ok(r.messages[0].content.includes("## Subagent Model"));
  assert.ok(r.messages[3].content.includes("<system-notification>"));
  assert.ok(r.messages[3].content.includes("$ du -hxd1"));
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"));
  assert.ok(event.payload.messages[0].content.includes("PROJECT CODEBASE"));
});

test("stabilizePayload: Responses — strips CODEBASE, injects, strips IDs", () => {
  const event = {
    payload: {
      model: "gpt-5",
      input: [
        { type: "message", role: "system", content: [{ type: "text", text: "You are helpful.\n\n[PROJECT CODEBASE — File structure]\n- file.js\n\n## Subagent Model\n\nDone." }] },
        { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
        { type: "message", role: "assistant", id: "msg_rnd", content: [] },
        { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
        { type: "function_call_output", call_id: "call_rnd", output: "ok" },
        { type: "message", role: "user", content: [{ type: "text", text: "tell me more" }] }
      ],
      store: false
    }
  };
  const r = stabilizePayload(event);
  assert.ok(!r.input[0].content[0].text.includes("PROJECT CODEBASE"));
  assert.ok(r.input[5].content.some(c => c.text?.includes("<system-notification>")));
  assert.ok(!r.input[1].content.some(c => c.text?.includes("<system-notification>")));
  assert.equal(r.input[3].id, undefined);
  assert.equal(r.input[3].call_id, undefined);
  assert.equal(r.input[4].call_id, undefined);
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("stabilizePayload: append-only — each round's user gets its own notification", () => {
  const event = {
    payload: {
      model: "test",
      messages: [
        { role: "system", content: "Static system.\n\n[PROJECT CODEBASE — File structure (generated 2026-04-27T09:32:03Z)]\n- file.js\n\n## Subagent Model\n\nDo work." },
        { role: "user", content: "hello\n\n<system-notification>\nRound 1\n</system-notification>" },
        { role: "assistant", content: "Hi." },
        { role: "user", content: "tell me more\n\n<system-notification>\nRound 2\n</system-notification>" },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "more details" }
      ]
    }
  };
  const r = stabilizePayload(event);
  assert.ok(r.messages[1].content.includes("Round 1"), "第 1 轮保留");
  assert.ok(r.messages[3].content.includes("Round 2"), "第 2 轮保留");
  assert.ok(r.messages[5].content.includes("<system-notification>"), "第 3 轮新增");
  const count = r.messages.reduce((s, m) =>
    s + (typeof m.content === "string" ? (m.content.match(/<system-notification>/g) || []).length : 0), 0);
  assert.equal(count, 3);
});

test("stabilizePayload: injects notification even without CODEBASE", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n## Subagent Model\n\nDone." },
    { role: "user", content: "hello" }
  ]}});
  assert.ok(r);
  assert.ok(r.messages[1].content.includes("<system-notification>"));
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"));
  assert.ok(r.messages[0].content.includes("Static."));
});

test("stabilizePayload: handles array content user messages", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- file.js\n\n## Subagent Model\n\nInstructions." },
    { role: "user", content: [{ type: "text", text: "hello" }] }
  ]}});
  assert.ok(r);
  assert.ok(r.messages[1].content.some(c => c.text?.includes("<system-notification>")));
});

test("stabilizePayload: cache key stable across timestamps", () => {
  const make = ts => ({ payload: { messages: [
    { role: "system", content: `Static.\n\n[PROJECT CODEBASE — (generated ${ts})]\n- file.js\n\n## Subagent Model\n\nDone.` },
    { role: "user", content: "hello" }
  ]}});
  assert.equal(stabilizePayload(make("A")).prompt_cache_key, stabilizePayload(make("B")).prompt_cache_key);
});

test("stabilizePayload: preserves other payload fields", () => {
  const r = stabilizePayload({ payload: {
    model: "deepseek-v4", stream: true, max_completion_tokens: 8192,
    tools: [{ type: "function", function: { name: "test" } }],
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## Subagent Model\n\nDone." },
      { role: "user", content: "hi" }
    ]
  }});
  assert.equal(r.model, "deepseek-v4");
  assert.equal(r.stream, true);
  assert.equal(r.max_completion_tokens, 8192);
  assert.equal(r.reasoning_effort, "high");
  assert.equal(r.tools[0].function.name, "test");
});

// ===========================================================================
// stabilizeIds
// ===========================================================================

test("stabilizeIds: strips assistant message id and function_call id/call_id", () => {
  const input = [
    { type: "message", role: "assistant", id: "msg_rnd", content: [] },
    { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
    { type: "function_call_output", call_id: "call_rnd", output: "ok" },
    { type: "message", role: "assistant", id: "msg_other", content: [] }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, undefined);
  assert.equal(out[1].id, undefined);
  assert.equal(out[1].call_id, undefined);
  assert.equal(out[2].call_id, undefined);
  assert.equal(out[3].id, undefined);
  assert.ok(out !== input);
});

test("stabilizeIds: preserves reasoning items and strips function_call_output call_id", () => {
  const input = [
    { type: "reasoning", id: "rs_id" },
    { type: "function_call_output", call_id: "late" }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, "rs_id");
  assert.equal(out[1].call_id, undefined);
});

test("stabilizeIds: strips already-stable IDs too", () => {
  const input = [
    { type: "message", role: "assistant", id: "msg_0", content: [] }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, undefined);
  assert.ok(out !== input);
});

// ===========================================================================
// generateFileListing
// ===========================================================================

test("generateFileListing: du -hxd1 style", () => withTmp(dir => {
  writeFileSync(join(dir, "small.txt"), "hi");
  writeFileSync(join(dir, ".hidden"), "secret");
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "util.js"), "export const x = 1;");

  const lines = generateFileListing(dir).split("\n").filter(Boolean);
  assert.ok(lines.find(l => l.endsWith("  small.txt")).match(/^\s+\d+B\s+small\.txt$/));
  assert.ok(lines.find(l => l.endsWith("  .hidden")));
  assert.ok(lines.find(l => l.endsWith("  lib/")).match(/^\s+\d+B\s+lib\//));
  assert.ok(!lines.find(l => l.includes("util.js")));
}));

test("generateFileListing: returns empty for invalid dir", () => {
  assert.equal(generateFileListing("/nonexistent"), "");
});

// ===========================================================================
// projectMessages
// ===========================================================================

test("projectMessages: passes through with no summaries", () => {
  const result = projectMessages([
    { role: "user", content: "hello" },
    { role: "toolResult", toolCallId: "call1", content: "result1" }
  ]);
  assert.equal(result.length, 2);
});

// ===========================================================================
// before_provider_request — cache key + ID stabilization
// ===========================================================================

test("before_provider_request — Chat: only sets cache key", () => {
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
  const result = events["before_provider_request"]({
    payload: { model: "test", store: false,
      messages: [
        { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Subagent Model\n\nDone." },
        { role: "user", content: "hello" }
      ]
    }
  });
  assert.ok(result);
  assert.ok(result.messages[0].content.includes("PROJECT CODEBASE"));
  assert.ok(!result.messages[1].content.includes("<system-notification>"));
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("before_provider_request — Responses: cache key + ID stripping", () => {
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
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
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("before_provider_request — Responses: works without CODEBASE", () => {
  const events = {};
  contextPrunePlugin({ on: (e, cb) => { events[e] = cb; }, registerTool: () => {}, registerCommand: () => {} });
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
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

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
