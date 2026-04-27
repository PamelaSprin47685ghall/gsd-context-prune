import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextPrunePlugin, {
  loadHintSources,
  buildHintsBlock,
  stabilizeResponsesInput,
  stabilizeResponsesPayload,
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

test("registers all lifecycle hooks, tools, and commands", () => {
  const events = {};
  const tools = [];
  const commands = [];

  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: (t) => tools.push(t),
    registerCommand: (n, o) => commands.push({ name: n, options: o })
  });

  // before_agent_start 已移除 — 一次成型不再需要
  assert.equal(typeof events["before_provider_request"], "function", "before_provider_request");
  assert.equal(typeof events["session_start"], "function", "session_start");
  assert.equal(typeof events["context"], "function", "context");
  assert.equal(typeof events["turn_end"], "function", "turn_end");
  assert.equal(events["before_agent_start"], undefined, "before_agent_start 已移除");

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "context_prune");

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "pruner");
});

// ===========================================================================
// loadHintSources
// ===========================================================================

test("loadHintSources: loads global hints and prefers .gsd/HINTS.md", () => withTmp(pDir => withTmp(gDir => {
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

test("loadHintSources: returns empty array when no hints exist", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 0);
  });
})));

// ===========================================================================
// buildHintsBlock
// ===========================================================================

test("buildHintsBlock: returns empty string when no hints exist", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => {
    assert.equal(buildHintsBlock(pDir), "");
  });
})));

test("buildHintsBlock: builds formatted hints block", () => withTmp(pDir => withTmp(gDir => {
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
// stabilizeResponsesPayload / stabilizeResponsesInput
// ===========================================================================

test("stabilizes cache key and identifiers", () => withEnv("GSD_HINTS_PROMPT_CACHE_KEY", "key", () => {
  const p = {
    model: "gpt-5",
    input: [
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "message", role: "assistant", id: "msg_rnd", content: [] },
      { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
      { type: "function_call_output", call_id: "call_rnd", output: "ok" },
      { type: "message", role: "assistant", id: "msg_rnd2", content: [] }
    ],
    prompt_cache_key: "old", store: false
  };
  const r = stabilizeResponsesPayload({ type: "before_provider_request", payload: p, model: { api: "openai-responses", provider: "openai" } });
  assert.equal(r.prompt_cache_key, "key");
  assert.equal(r.input[2].id, "msg_0");
  assert.equal(r.input[3].id, "fc_0");
  assert.equal(r.input[3].call_id, "call_0");
  assert.equal(r.input[4].call_id, "call_0");
  assert.equal(r.input[5].id, "msg_1");
  assert.equal(p.prompt_cache_key, "old");
}));

test("stabilizes response input arrays safely", () => {
  const { input, changed } = stabilizeResponsesInput([
    { type: "reasoning", id: "rs_id" },
    { type: "function_call_output", call_id: "late" }
  ]);
  assert.ok(changed);
  assert.equal(input[0].id, "rs_id");
  assert.equal(input[1].call_id, "call_0");
});

test("ignores non-Responses provider payloads", () => {
  const r = stabilizeResponsesPayload({ payload: { messages: [] }, model: { api: "anthropic-messages" } });
  assert.equal(r, undefined);
});

test("stabilizeResponsesPayload: returns undefined for non-object payload", () => {
  assert.equal(stabilizeResponsesPayload({ payload: null }), undefined);
  assert.equal(stabilizeResponsesPayload({ payload: "string" }), undefined);
  assert.equal(stabilizeResponsesPayload({ payload: [] }), undefined);
});

test("stabilizeResponsesPayload: auto-computes cache key from system/developer text", () => {
  const p = {
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" }
    ],
    store: false
  };
  const r = stabilizeResponsesPayload({ payload: p, model: { api: "openai-responses" } });
  assert.ok(r?.prompt_cache_key?.startsWith("gsd-hints:"));
});

// ===========================================================================
// gsd-context-prune: primary summary projection
// ===========================================================================

test("projectMessages: passes through with no summaries", () => {
  const mockMessages = [
    { role: "user", content: "hello" },
    { role: "toolResult", toolCallId: "call1", content: "result1" }
  ];
  const result = projectMessages(mockMessages);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, "user");
  assert.equal(result[1].toolCallId, "call1");
});

// ===========================================================================
// gsd-context-prune: integration via plugin
// ===========================================================================

test("full integration: session_start restores persisted summaries", () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {},
    registerCommand: () => {}
  });

  // Simulate session_start with persisted branch data
  events["session_start"]({}, {
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "context-prune-primary-data",
          data: {
            toolCallIds: ["call1", "call2"],
            latestId: "call2",
            summaryText: "Tested summary text"
          }
        }
      ]
    }
  });

  // Now context should project
  const mockMessages = [
    { role: "user", content: "test" },
    { role: "toolResult", toolCallId: "call1", content: "huge raw result 1" },
    { role: "toolResult", toolCallId: "call2", content: "huge raw result 2" },
    { role: "toolResult", toolCallId: "call3", content: "unpruned result 3" }
  ];

  const result = events["context"]({ messages: mockMessages });

  assert.equal(result.messages.length, 3, "should replace 2 tool results with 1 summary");
  assert.equal(result.messages[0].role, "user");

  const summaryMsg = result.messages[1];
  assert.equal(summaryMsg.role, "custom");
  assert.equal(summaryMsg.customType, "context-prune-primary");
  assert.ok(summaryMsg.content.includes("Tested summary text"));

  assert.equal(result.messages[2].toolCallId, "call3", "unpruned result remains");
});

test("does not trigger global summary on aborted or error stops", () => {
  const events = {};
  const notifications = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: () => {}
  });

  events["session_start"]({}, { sessionManager: { getBranch: () => [] } });
  events["context"]({ messages: [{ role: "user", content: "hi" }] });

  events["turn_end"]({
    message: { stopReason: "error" }
  }, {
    getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }),
    ui: { notify: (m) => notifications.push(m) }
  });

  // No global summary notifications should fire for error stops
  assert.ok(!notifications.some(n => n.includes("高级精简")), "no global summary on error");
});

test("context hook does not inject assistant messages (one-shot pattern)", () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {},
    registerCommand: () => {}
  });

  events["session_start"]({}, { sessionManager: { getBranch: () => [] } });

  // 一次成型：custom 消息不再由本插件产生，所以直接透传
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "cwd: /tmp" },
    { role: "user", content: "do something" }
  ];

  const result = events["context"]({ messages: msgs });
  // 不再插入 assistant 消息
  const assMsgs = result.messages.filter(m => m.role === "assistant");
  assert.equal(assMsgs.length, 0, "不应注入额外的 assistant 消息");
  assert.equal(result.messages.length, 3, "消息数量不变");
});
