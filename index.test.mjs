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
  stabilizeChatPayload,
  stabilizePayload,
  generateFileListing,
  setCodebaseDir,
  projectMessages,
  projectSystem
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
// stabilizePayload — 统一缓存稳定化（所有格式，一条路）
// ===========================================================================

test("stabilizePayload: Chat Completions — extracts CODEBASE, appends to last user", () => {
  const event = {
    payload: {
      model: "test-model",
      messages: [
        {
          role: "system",
          content: [
            "You are a helpful assistant.",
            "",
            "[PROJECT CODEBASE — File structure and descriptions (generated 2026-04-27T09:32:03Z)]",
            "",
            "# Codebase Map",
            "Generated: 2026-04-27T09:32:03Z | Files: 500",
            "",
            "### src/",
            "- `src/main.js`",
            "",
            "## Subagent Model",
            "",
            "When spawning subagents, pass model: \"test-model\"."
          ].join("\n")
        },
        { role: "user", content: "what is the weather?" },
        { role: "assistant", content: "Let me check." },
        { role: "user", content: "tell me more" }
      ],
      stream: true,
      store: false
    }
  };

  const r = stabilizePayload(event);

  // System 不再包含 CODEBASE
  assert.ok(!r.messages[0].content.includes("PROJECT CODEBASE"));
  assert.ok(r.messages[0].content.includes("You are a helpful assistant"));
  assert.ok(r.messages[0].content.includes("## Subagent Model"));

  // 仅最后一条 user 有 notification
  r.messages.forEach((m, i) => {
    const hasNotif = typeof m.content === "string"
      ? m.content.includes("<system-notification>")
      : Array.isArray(m.content) && m.content.some(c => c.text?.includes("<system-notification>"));
    if (i === 3) assert.ok(hasNotif, `索引 ${i} 是最后一条 user`);
    else if (m.role === "user") assert.ok(!hasNotif, `索引 ${i} 不是最后 user`);
  });

  // notification 包含实时文件列表
  const lastUser = r.messages[3];
  assert.ok(lastUser.content.includes("<system-notification>"));
  assert.ok(lastUser.content.includes("$ du -hxd1"));
  assert.ok(lastUser.content.includes("</system-notification>"));

  // prompt_cache_key
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"));
  assert.ok(event.payload.messages[0].content.includes("PROJECT CODEBASE"));
});

test("stabilizePayload: Responses API — extracts CODEBASE, appends, plus ID stabilization", () => {
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

  const lastUser = r.input[5];
  assert.ok(lastUser.content.some(c => c.text?.includes("<system-notification>")), "最后 user 有 notification");
  assert.ok(lastUser.content.some(c => c.text?.includes("$ du -hxd1")), "包含实时文件列表");
  const firstUser = r.input[1];
  assert.ok(!firstUser.content.some(c => c.text?.includes("<system-notification>")), "第一条 user 没有 notification");

  assert.ok(r.input[3].id?.startsWith("fc_"));
  assert.ok(r.input[3].call_id?.startsWith("call_"));
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("stabilizePayload: append-only — 每轮在最后一条 user 追加，旧 notification 不删", () => {
  // 模拟三轮积累后的 payload
  // 第 1 轮: user("hello") 是最后 user → 追加 notif_A
  // 第 2 轮: user("hello" + notif_A) 已保留, user("tell me more") 是最后 → 追加 notif_B
  // 第 3 轮: 两条旧 user 各有自己的 notification, user("more details") 是最后 → 追加 notif_C
  const event = {
    payload: {
      model: "test",
      messages: [
        {
          role: "system",
          content: [
            "Static system.",
            "",
            "[PROJECT CODEBASE — File structure (generated 2026-04-27T09:32:03Z)]",
            "- old-file.js",
            "",
            "## Subagent Model",
            "",
            "Do work."
          ].join("\n")
        },
        // 第 1 轮的 user（已在历史中带着自己的 notification）
        { role: "user", content: "hello\n\n<system-notification>\nNotif from round 1\n</system-notification>" },
        { role: "assistant", content: "Hi there." },
        // 第 2 轮的 user（也在历史中带着自己的 notification）
        { role: "user", content: "tell me more\n\n<system-notification>\nNotif from round 2\n</system-notification>" },
        { role: "assistant", content: "Sure." },
        // 第 3 轮新来的 user（尚未有 notification → 本回合追加）
        { role: "user", content: "more details" }
      ]
    }
  };

  const r = stabilizePayload(event);

  // 每条旧 user 各自的 notification 全部保留（无删减）
  assert.ok(r.messages[1].content.includes("Notif from round 1"), "第 1 轮 notification 保留");
  assert.ok(r.messages[3].content.includes("Notif from round 2"), "第 2 轮 notification 保留");

  // 本轮（第 3 轮）new user 追加了新的 notification
  assert.ok(r.messages[5].content.includes("<system-notification>"), "第 3 轮 user 有 notification");
  assert.ok(r.messages[5].content.includes("$ du -hxd1"), "包含实时文件列表");

  // 三条 user 各一个 notification
  const notifCount = r.messages.reduce((sum, m) =>
    sum + (typeof m.content === "string" ? (m.content.match(/<system-notification>/g) || []).length : 0), 0);
  assert.equal(notifCount, 3, "三条 user 共 3 个 notification");
});

test("stabilizePayload: returns modified payload with notification when no CODEBASE", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n## Subagent Model\n\nDone." },
    { role: "user", content: "hello" }
  ]}});
  assert.ok(r, "should return a payload even without CODEBASE");
  assert.ok(r.messages[1].content.includes("<system-notification>"), "should inject notification");
  assert.ok(r.prompt_cache_key?.startsWith("gsd-hints:"), "should set cache key");
  // system prompt unchanged (no CODEBASE to strip)
  assert.ok(r.messages[0].content.includes("Static."));
  assert.ok(r.messages[0].content.includes("## Subagent Model"));
});

test("stabilizePayload: handles array content user message", () => {
  const r = stabilizePayload({ payload: { messages: [
    { role: "system", content: "Static.\n\n[PROJECT CODEBASE — File structure]\n- file.js\n\n## Subagent Model\n\nInstructions." },
    { role: "user", content: [{ type: "text", text: "hello" }] }
  ]}});
  assert.ok(r);
  assert.ok(r.messages[1].content.some(c => c.type === "text" && c.text?.includes("<system-notification>")));
});

test("stabilizePayload: cache key stable across timestamps", () => {
  const make = ts => ({ payload: { messages: [
    { role: "system", content: `Static.\n\n[PROJECT CODEBASE — (generated ${ts})]\n- file.js\n\n## Subagent Model\n\nDone.` },
    { role: "user", content: "hello" }
  ]}});
  const r1 = stabilizePayload(make("2026-04-27T09:32:03Z"));
  const r2 = stabilizePayload(make("2026-04-27T09:31:05Z"));
  assert.equal(r1.prompt_cache_key, r2.prompt_cache_key);
  assert.equal(r1.messages[0].content, r2.messages[0].content);
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

test("before_provider_request — Chat: cache key only, no monkey patching", () => {
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
  // before_provider_request 只设 cache key，猴子补丁（CODEBASE 剥离 + notification）在 context hook
  assert.ok(result);
  assert.ok(result.messages[0].content.includes("PROJECT CODEBASE"), "CODEBASE 不在 before_provider_request 剥离");
  assert.ok(!result.messages[1].content.includes("<system-notification>"), "notification 不在 before_provider_request 注入");
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("before_provider_request — Responses API: cache key + ID 稳定化", () => {
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
  // CODEBASE 剥离 + notification 注入在 context hook，不在 before_provider_request
  assert.ok(result);
  assert.ok(result.input[0].content.includes("Static."), "system content 不变");
  // ID 稳定化（Responses 专用）
  assert.ok(result.input[2].id?.startsWith("msg_"), "assistant ID 已稳定化");
  // cache key
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

test("before_provider_request — Responses API: cache key + ID 无 CODEBASE 场景", () => {
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
  assert.ok(result.input[2].id?.startsWith("msg_"), "ID 已稳定化");
  assert.ok(result.prompt_cache_key?.startsWith("gsd-hints:"));
});

// ===========================================================================
// generateFileListing
// ===========================================================================

test("generateFileListing: du -hxd1 style from temp dir", () => withTmp(dir => {
  writeFileSync(join(dir, "small.txt"), "hi");
  writeFileSync(join(dir, ".hidden"), "secret");
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "util.js"), "export const x = 1;");

  const listing = generateFileListing(dir);
  const lines = listing.split("\n").filter(Boolean);

  // small.txt — 普通文件，大小可读格式
  const fileLine = lines.find(l => l.endsWith("  small.txt"));
  assert.ok(fileLine, "应有 small.txt 行");
  assert.ok(fileLine.match(/^\s+\d+B\s+small\.txt$/), "文件大小格式如  2B  small.txt");

  // .hidden — 隐藏文件
  const hiddenLine = lines.find(l => l.endsWith("  .hidden"));
  assert.ok(hiddenLine, "应有 .hidden 行");

  // lib/ — 目录递归总大小
  const dirLine = lines.find(l => l.endsWith("  lib/"));
  assert.ok(dirLine, "应有 lib/ 行");
  assert.ok(dirLine.match(/^\s+\d+B\s+lib\//), "目录大小是递归总大小");

  // 不递归进子目录的条目
  const utilLine = lines.find(l => l.includes("util.js"));
  assert.ok(!utilLine, "不应递归列出 lib/util.js");
}));

test("generateFileListing: returns empty string for invalid dir", () => {
  assert.equal(generateFileListing("/nonexistent/dir/xyz"), "");
});

// ===========================================================================
// projectMessages
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
// projectSystem
// ===========================================================================

test("projectSystem: strips CODEBASE from system prompt", () => {
  const msgs = [
    { role: "system", content: "You are helpful.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## Subagent Model\n\nDone." },
    { role: "user", content: "hello" }
  ];
  setCodebaseDir("/tmp");
  const r = projectSystem(msgs, "/tmp");
  assert.ok(r !== msgs, "returns new array when modified");
  assert.ok(!r[0].content.includes("PROJECT CODEBASE"), "CODEBASE 已剥离");
  assert.ok(r[0].content.includes("You are helpful"), "system 其他内容保留");
  assert.ok(r[0].content.includes("## Subagent Model"), "边界标记保留");
});

test("projectSystem: appends file listing to last user", () => withTmp(dir => {
  writeFileSync(join(dir, "hello.txt"), "world");
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "last" }
  ];
  const r = projectSystem(msgs, dir);
  assert.ok(r !== msgs, "returns new array");
  // 最后一条 user 有 notification
  assert.ok(r[3].content.includes("<system-notification>"), "最后 user 有 notification");
  assert.ok(r[3].content.includes("$ du -hxd1"), "包含实时文件列表");
  assert.ok(r[3].content.includes("hello.txt"), "包含目录内容");
  // 第一条 user 没有 notification
  assert.ok(!r[1].content.includes("<system-notification>"), "第一条 user 无 notification");
  // 原始数据不变
  assert.ok(!msgs[3].content.includes("<system-notification>"));
}));

test("projectSystem: idempotent — does not re-add notification if already present", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi\n\n<system-notification>\nAlready here\n</system-notification>" }
  ];
  const r = projectSystem(msgs);
  // 原始数组中已有 notification → 不再追加
  assert.ok(r === msgs, "returns original array when no changes");
  assert.equal(r[1].content.match(/<system-notification>/g).length, 1, "notification 不重复");
});

test("projectSystem: handles array content messages", () => withTmp(dir => {
  const msgs = [
    { role: "developer", content: [{ type: "text", text: "Static.\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Subagent Model\n\nDone." }] },
    { role: "user", content: [{ type: "text", text: "hello" }] }
  ];
  const r = projectSystem(msgs, dir);
  assert.ok(r !== msgs);
  assert.ok(!r[0].content[0].text.includes("PROJECT CODEBASE"), "array content 中 CODEBASE 已剥离");
  assert.ok(r[1].content.some(c => c.text?.includes("<system-notification>")), "array content user 有 notification");
}));

test("projectSystem: preserves non-system messages unchanged", () => {
  const msgs = [
    { role: "user", content: "just a user message" },
    { role: "assistant", content: "assistant reply" }
  ];
  // 没有 system/developer, 有 user → 追加 notification, 但 assistant 不变
  const r = projectSystem(msgs);
  assert.ok(r !== msgs);
  assert.equal(r[0].content, msgs[0].content + r[0].content.slice(msgs[0].content.length));
  assert.equal(r[1].content, "assistant reply", "assistant 消息不变");
});

test("projectSystem: empty messages returns as-is", () => {
  const msgs = [];
  const r = projectSystem(msgs);
  assert.ok(r === msgs, "same reference for empty array");
  assert.equal(r.length, 0);
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
