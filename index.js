import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

// ==========================================================================
// gsd-context-prune
//
// Pipeline — 每一步做一件事，顺序执行，无 fallback：
//   stripCodebase → injectListing → computeCacheKey → stabilizeIds → projectSummaries
// ==========================================================================

const read = p => { try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }};

// ── Step 0: HINTS ─────────────────────────────────────────────────────────

export function loadHintSources(cwd) {
  const home = process.env.GSD_HOME || path.join(os.homedir(), ".gsd");
  const g = read(path.join(home, "HINTS.md"));
  const out = g ? [{ label: "Global", path: path.join(home, "HINTS.md"), content: g }] : [];
  if (cwd) {
    const p = read(path.join(cwd, ".gsd", "HINTS.md")) || read(path.join(cwd, "HINTS.md"));
    if (p) out.push({ label: "Project", path: "", content: p });
  }
  return out;
}

export function buildHintsBlock(cwd) {
  const s = loadHintSources(cwd);
  if (!s.length) return "";
  return `[HINTS — Stable Guidance]\n\nThese instructions come from HINTS.md files and are intentionally injected into the stable system prompt.\n\n${
    s.map(x => `## ${x.label} HINTS (${x.path})\n\n${x.content}`).join("\n\n")}`;
}

/** 在第一个 system/developer 消息头部注入 HINTS 块（幂等：已存在则不重复注入）。 */
function injectHints(messages) {
  const block = buildHintsBlock(listingDir);
  if (!block) return messages;
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") {
      if (m.content.includes("[HINTS — Stable Guidance]")) return m;
      changed = true;
      return { ...m, content: block + "\n\n" + m.content };
    }
    if (Array.isArray(m.content)) {
      if (m.content.some(c => c.text?.includes("[HINTS — Stable Guidance]"))) return m;
      changed = true;
      return { ...m, content: [{ type: "text", text: block + "\n\n" }, ...m.content] };
    }
    return m;
  });
  return changed ? out : messages;
}

// ── Step 1: CODEBASE 剥离 ─────────────────────────────────────────────────

const CB_START = "[PROJECT CODEBASE —";
const CB_STOPS = ["## Subagent Model", "## GSD Skill Preferences", "# Tools", "## Tools"];

/** 从文本中剥离 CODEBASE 块。返回 { stable, dynamic } 或 null（无 CODEBASE 时）。 */
export function stripCodebase(text) {
  const s = text.indexOf(CB_START);
  if (s === -1) return null;
  let e = -1;
  for (const stop of CB_STOPS) {
    const i = text.indexOf(stop, s + 1);
    if (i !== -1 && (e === -1 || i < e)) e = i;
  }
  return e === -1 ? null : { stable: text.slice(0, s) + text.slice(e), dynamic: text.slice(s, e).trim() };
}

/** 对 messages 中所有 system/developer 消息应用 stripCodebase。 */
function stripMessages(messages) {
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") {
      const r = stripCodebase(m.content);
      if (!r) return m;
      changed = true;
      return { ...m, content: r.stable };
    }
    if (Array.isArray(m.content)) {
      let ok = false;
      const c = m.content.map(x => {
        if (x.type !== "text") return x;
        const r = stripCodebase(x.text);
        if (!r) return x;
        ok = true;
        return { ...x, text: r.stable };
      });
      return ok ? (changed = true, { ...m, content: c }) : m;
    }
    return m;
  });
  return changed ? out : messages;
}

// ── Step 2: 文件列表注入 ────────────────────────────────────────────────────

function sizeStr(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M";
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + "K" : bytes + "B";
}

function dirSize(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .reduce((sum, item) => {
        const fp = path.join(dir, item.name);
        try { return sum + (fs.statSync(fp).isDirectory() ? dirSize(fp) : fs.statSync(fp).size); } catch { return sum; }
      }, 0);
  } catch { return 0; }
}

/** 生成 du -hxd1 风格的文件列表。 */
export function generateFileListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(item => {
      const fp = path.join(dir, item.name);
      try {
        const st = fs.statSync(fp);
        const sz = st.isDirectory() ? dirSize(fp) : st.size;
        return `${sizeStr(sz).padStart(8)}  ${item.name}${st.isDirectory() ? "/" : ""}`;
      } catch { return ""; }
    }).filter(Boolean).join("\n");
  } catch { return ""; }
}

let listingDir = process.cwd();
export function setCodebaseDir(d) { listingDir = d; }

/** 在最后一条 user 消息追加 <system-notification>（幂等：已有则不重复追加）。 */
function injectListing(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map(c => c.text || "").join("") : "";
    if (t.includes("<system-notification>")) return messages;
    const list = generateFileListing(listingDir);
    if (!list) return messages;
    const notif = `\n\n<system-notification>\n$ du -hxd1\n${list}\n</system-notification>`;
    const out = messages.map(x => ({ ...x }));
    const u = out[i];
    if (typeof u.content === "string") u.content += notif;
    else if (Array.isArray(u.content)) u.content = [...u.content, { type: "text", text: notif.trim() }];
    return out;
  }
  return messages;
}

// ── Step 3: 缓存键 ─────────────────────────────────────────────────────────

function sysText(messages) {
  return messages
    .filter(m => m.role === "system" || m.role === "developer")
    .map(m => typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map(c => c.text || "").join("\n") : "")
    .join("\n");
}

function computeCacheKey(messages) {
  const env = process.env.GSD_HINTS_PROMPT_CACHE_KEY;
  if (env?.trim()) return env.trim();
  const t = sysText(messages);
  return t ? `gsd-hints:${createHash("sha256").update(t).digest("hex").slice(0, 24)}` : "";
}

// ── Step 4: ID 剥离（Completions / Responses API）─────────────────────────

/** 剥离 assistant message 的 id 和 function_call 的 id/call_id，
 *  这些随机 ID 在 API 回传中无需复用，直接去掉让 provider 自动分配即可。 */
export function stabilizeIds(input) {
  let changed = false;
  const out = input.map(x => {
    if (!x || typeof x !== "object") return x;
    if (x.type === "message" && x.role === "assistant" && typeof x.id === "string") {
      const { id, ...rest } = x;
      changed = true;
      return rest;
    }
    if (x.type === "function_call" && (typeof x.id === "string" || typeof x.call_id === "string")) {
      const { id, call_id, ...rest } = x;
      changed = true;
      return rest;
    }
    if (x.type === "function_call_output" && typeof x.call_id === "string") {
      const { call_id, ...rest } = x;
      changed = true;
      return rest;
    }
    return x;
  });
  return changed ? out : input;
}

// ── Step 5: 摘要投影 ────────────────────────────────────────────────────────

let summaries = []; // { type:'primary'|'global', ... }

function zeroContent(v) { return []; }

/** 保持结构，把已折叠消息的内容清空为 0 字节，并注入摘要。 */
export function projectMessages(messages) {
  let result = messages;
  for (const s of summaries) {
    if (s.type === "primary") {
      const ids = new Set(s.toolCallIds);
      let pos = -1, keep = [];
      for (const m of result) {
        if (m.role === "toolResult" && ids.has(m.toolCallId || m.id)) {
          if ((m.toolCallId || m.id) === s.latestId) pos = keep.length;
          keep.push({ ...m, content: zeroContent(m.content) });
          continue;
        }
        keep.push(m);
      }
      if (pos !== -1) {
        keep[pos] = {
          ...keep[pos],
          content: [{ type: "text", text: `【初级精简摘要】\n${s.text}` }]
        };
      }
      result = keep;
    }
    if (s.type === "global") {
      const ids = s.collapsedIds;
      let kept = [], inserted = false;
      let afterSys = -1;
      for (let i = 0; i < result.length; i++) {
        const m = result[i];
        if (m.role === "system" || m.role === "developer") {
          kept.push(m);
          if (afterSys === -1) afterSys = kept.length;
          continue;
        }
        if (m.id && ids.has(m.id)) {
          if (!inserted && afterSys !== -1) {
            kept.splice(afterSys, 0, {
              id: `global-sum-${s.timestamp}`, role: "assistant",
              content: [{ type: "text", text: `【高级精简：世界线坍缩】\n${s.text}` }]
            });
            afterSys++;
            inserted = true;
          }
          kept.push({ ...m, content: zeroContent(m.content) });
          continue;
        }
        kept.push(m);
      }
      result = kept;
    }
  }
  return result;
}

// ── Step 6: 后台总结（sidecar）──────────────────────────────────────────────

let summarizerModelId = "default";
const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "context-prune.json");

try {
  const data = JSON.parse(read(SETTINGS_PATH) || "{}");
  if (data.summarizerModelId) summarizerModelId = data.summarizerModelId;
} catch {}

function saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ summarizerModelId }));
  } catch {}
}

let pendingToolCalls = [];
let summarizing = false;

async function triggerPrimarySummary(ctx, pi, batches) {
  summarizing = true;
  ctx.ui.notify(`pruner: 正在进行初级精简 (${batches.length} 个工具调用)...`, "info");
  try {
    const model = summarizerModelId === "default" ? ctx.model
      : ctx.modelRegistry?.find(...summarizerModelId.split("/")) || ctx.model;
    const mod = await import("@gsd/pi-ai");
    const apiKey = await ctx.modelRegistry?.getApiKey(model);
    const text = batches.map(b =>
      `Tool: ${b.name}\nArgs: ${JSON.stringify(b.args)}\nResult: ${(b.result || "").slice(0, 2000)}`
    ).join("\n\n---\n\n");
    const prompt = "你是一个总结助手。请将以下 AI 工具调用记录浓缩为简短的摘要。\n" +
      "仅保留：工具名、执行了什么、关键结果（成功/失败及核心数据）、未来需要的发现。\n" +
      "忽略琐碎的无用输出。\n\n<tool-calls>\n" + text + "\n</tool-calls>";
    const res = await mod.complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, { apiKey, headers: model.headers });
    const summaryText = res.content.map(c => c.text).join("\n");
    const toolCallIds = batches.map(b => b.id);
    const latestId = toolCallIds[toolCallIds.length - 1];
    summaries.push({ type: "primary", toolCallIds, latestId, text: summaryText });
    pi.appendEntry("context-prune-primary-data", { toolCallIds, latestId, text: summaryText });
    ctx.ui.notify("pruner: 初级精简完成，工具输出已被折叠。", "success");
  } catch (err) {
    ctx.ui.notify(`pruner: 初级精简失败 - ${err.message}`, "error");
  } finally { summarizing = false; }
}

async function triggerGlobalSummary(ctx, pi, projectedMessages) {
  summarizing = true;
  ctx.ui.notify("pruner: 正在进行高级精简 (全局世界线坍缩)...", "info");
  try {
    const model = summarizerModelId === "default" ? ctx.model
      : ctx.modelRegistry?.find(...summarizerModelId.split("/")) || ctx.model;
    const mod = await import("@gsd/pi-ai");
    const apiKey = await ctx.modelRegistry?.getApiKey(model);
    const text = projectedMessages.map(m => {
      const c = Array.isArray(m.content) ? m.content.map(x => x.text || JSON.stringify(x)).join("\n")
        : typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${c}`;
    }).join("\n\n");
    const prompt = "请将以下所有的对话与执行历史，浓缩总结为\"问题背景\"和\"当前进度\"。\n" +
      "保留当前正在执行的任务目标、已确认的约束和接下来需要做的事情。\n" +
      "丢弃琐碎的尝试过程。\n\n<history>\n" + text + "\n</history>";
    const res = await mod.complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, { apiKey, headers: model.headers });
    const summaryText = res.content.map(c => c.text).join("\n");
    const collapsedIds = new Set(projectedMessages.map(m => m.id).filter(Boolean));
    summaries.push({ type: "global", collapsedIds, text: summaryText, timestamp: Date.now() });
    pi.appendEntry("context-prune-global-data", { collapsedIds: [...collapsedIds], text: summaryText, timestamp: Date.now() });
    ctx.ui.notify("pruner: 高级精简完成，历史已被折叠。", "success");
  } catch (err) {
    ctx.ui.notify(`pruner: 高级精简失败 - ${err.message}`, "error");
  } finally { summarizing = false; }
}

// ── 统一 Payload Pipeline ──────────────────────────────────────────────────

/**
 * 统一入口：将任意格式的 payload 归一处理。
 * pipeline: stripCodebase → injectListing → computeCacheKey → stabilizeIds
 */
export function stabilizePayload(event) {
  const p = event.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return;

  const isResponses = Array.isArray(p.input);
  const messages = isResponses ? p.input : Array.isArray(p.messages) ? p.messages : null;
  if (!messages || messages.length < 2) return;

  let m = stripMessages(messages);
  m = injectListing(m);
  const key = computeCacheKey(m);

  if (isResponses) {
    const input = stabilizeIds(m);
    return { ...p, input, prompt_cache_key: key };
  }
  return { ...p, messages: m, prompt_cache_key: key };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export default function contextPrunePlugin(pi) {
  pi.on("session_start", (event, ctx) => {
    summaries = [];
    pendingToolCalls = [];
    summarizing = false;
    for (const entry of ctx?.sessionManager?.getBranch?.() || []) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "context-prune-primary-data")
        summaries.push({ type: "primary", ...entry.data, toolCallIds: entry.data.toolCallIds });
      if (entry.customType === "context-prune-global-data")
        summaries.push({ type: "global", ...entry.data, collapsedIds: new Set(entry.data.collapsedIds) });
    }
    ctx.ui.notify(
      `pruner: 已加载。伴随模型 ${summarizerModelId}，会话摘要 ${summaries.length} 条已恢复。`,
      "info"
    );
  });

  // context hook：CODEBASE 剥离 → HINTS 注入 → 文件列表注入 → 摘要投影
  pi.on("context", (event) => {
    const messages = event.messages || [];
    const stripped = stripMessages(messages);
    const withHints = injectHints(stripped);
    const withListing = injectListing(withHints);
    return { messages: projectMessages(withListing) };
  });

  // turn_end：收集工具调用 + 触发全局摘要
  pi.on("turn_end", (event, ctx) => {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const toolCalls = content.filter(b => b.type === "toolCall") || [];
    const toolResults = event.toolResults || [];

    for (const tc of toolCalls) {
      const id = tc.id || tc.toolCallId;
      const res = toolResults.find(r => r.toolCallId === id || r.id === id);
      if (res) {
        pendingToolCalls.push({
          id, name: tc.name || tc.toolName,
          args: tc.arguments || tc.args || tc.input || {},
          result: Array.isArray(res.content)
            ? res.content.map(c => c.text || JSON.stringify(c)).join("\n")
            : String(res.content || "")
        });
      }
    }

    const usage = ctx?.getContextUsage?.();
    if (usage?.contextWindow > 0 && event.message?.stopReason !== "aborted" && event.message?.stopReason !== "error") {
      const tokens = usage.totalTokens || (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
      if (tokens / usage.contextWindow > 2 / 3 && !summarizing)
        triggerGlobalSummary(ctx, pi, projectMessages(event.messages || []));
    }
  });

  // before_provider_request：缓存键 + ID 稳定化
  pi.on("before_provider_request", (e) => {
    const p = e.payload;
    if (!p || typeof p !== "object") return;

    const isResponses = Array.isArray(p.input);
    const messages = isResponses ? p.input : Array.isArray(p.messages) ? p.messages : null;
    if (!messages) return;

    const key = computeCacheKey(stripMessages(messages));
    let result = key ? { ...p, prompt_cache_key: key } : p;
    let changed = result !== p;

    if (isResponses) {
      const input = stabilizeIds(p.input);
      if (input !== p.input) { result = { ...result, input }; changed = true; }
    }

    return changed ? result : undefined;
  });

  pi.registerTool({
    name: "context_prune",
    label: "Context Prune",
    description: "Summarize and prune preceding tool-call results to reduce context size. Call this after completing a batch of work.",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _sig, _onUpdate, ctx) => {
      if (pendingToolCalls.length > 0 && !summarizing) {
        ctx.ui.notify(`pruner: 开始精简 ${pendingToolCalls.length} 个工具调用...`, "info");
        triggerPrimarySummary(ctx, pi, [...pendingToolCalls]);
        pendingToolCalls.length = 0;
      } else if (pendingToolCalls.length > 0 && summarizing) {
        ctx.ui.notify("pruner: 上一轮精简仍在进行中，等待下一轮处理。", "info");
      } else {
        ctx.ui.notify("pruner: 当前无待精简的工具调用。", "info");
      }
      return { content: [{ type: "text", text: "Context prune processed." }] };
    }
  });

  pi.registerCommand("pruner", {
    description: "Manage context-prune summarizer model",
    handler: async (arg, ctx) => {
      if (arg.length > 0) {
        summarizerModelId = arg;
        saveSettings();
        ctx.ui.notify(`pruner: 伴随模型已切换为 ${summarizerModelId}`, "info");
      } else {
        ctx.ui.notify(`pruner: 当前伴随模型为 ${summarizerModelId}。用法: /pruner provider/model-id`, "info");
      }
    }
  });
}
