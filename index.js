import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

// ===========================================================================
// gsd-context-prune — 双层上下文修剪 (Primary + Global Summary)
//
// 不再使用 before_agent_start 钩子和 custom 消息的变通方案。
// 遵循一次成型方式：system(static) → user(dynamic) → ai(收到) → user(real)
//
// 保留的外部能力：
//   - loadHintSources / buildHintsBlock — 供上层调用者在构建 system prompt 时使用
//   - stabilizeResponsesInput / stabilizeResponsesPayload — Payload ID 稳定
//   - projectMessages — 双层级联精简投影
//   - 整体插件：session_start / context / turn_end / before_provider_request
// ===========================================================================

function readFile(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}

export function loadHintSources(cwd) {
  const s = [];
  const gPath = path.join(process.env.GSD_HOME || path.join(os.homedir(), ".gsd"), "HINTS.md");
  const g = readFile(gPath);
  if (g) s.push({ label: "Global", path: gPath, content: g });

  if (cwd) {
    const p1 = path.join(cwd, ".gsd", "HINTS.md"), p2 = path.join(cwd, "HINTS.md");
    const c1 = readFile(p1), c2 = readFile(p2);
    if (c1) s.push({ label: "Project", path: p1, content: c1 });
    else if (c2) s.push({ label: "Project", path: p2, content: c2 });
  }
  return s;
}

/**
 * buildHintsBlock — 构建 HINTS 静态注入块，供上层在构建 system prompt 时调用。
 * 返回空字符串表示无 HINTS。不涉及任何钩子或 custom 消息。
 */
export function buildHintsBlock(cwd) {
  const sources = loadHintSources(cwd);
  if (!sources.length) return "";
  return `[HINTS — Stable Guidance]

These instructions come from HINTS.md files and are intentionally injected into the stable system prompt.

${
    sources.map(s => `## ${s.label} HINTS (${s.path})\n\n${s.content}`).join("\n\n")
  }`;
}

// ===========================================================================
// 上下文修剪核心
// ===========================================================================

let summarizerModelId = "default";
const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "context-prune.json");

try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (data.summarizerModelId) summarizerModelId = data.summarizerModelId;
  }
} catch (e) {}

function saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ summarizerModelId }));
  } catch (e) {}
}

let primarySummaries = [];
let globalSummary = null;
let pendingToolCalls = [];
let lastContextMessages = [];
let isPrimarySummarizing = false;
let isGlobalSummarizing = false;

function resolveModel(ctx) {
  if (summarizerModelId === "default") return ctx.model;
  const slashIdx = summarizerModelId.indexOf("/");
  if (slashIdx === -1) return ctx.model;
  const provider = summarizerModelId.slice(0, slashIdx);
  const modelId = summarizerModelId.slice(slashIdx + 1);
  const model = ctx.modelRegistry?.find(provider, modelId);
  if (model) return model;
  ctx.ui?.notify(`pruner: 伴随模型 ${summarizerModelId} 未找到，降级为默认模型`, "warning");
  return ctx.model;
}

async function getCompleteFn() {
  try {
    const mod = await import("@gsd/pi-ai");
    return mod.complete;
  } catch (err) {
    throw new Error(
      "Cannot import @gsd/pi-ai — sidecar summarization disabled. " +
      "Ensure @gsd/pi-ai is installed and resolvable from this extension. " +
      err.message
    );
  }
}

export function projectMessages(rawMessages) {
  let messages = [...rawMessages];

  // ---- Primary Pruning ----
  for (const sum of primarySummaries) {
    const summarizedIds = new Set(sum.toolCallIds);
    let insertIndex = -1;
    const newMessages = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "toolResult" && summarizedIds.has(m.toolCallId || m.id)) {
        if ((m.toolCallId || m.id) === sum.latestId) {
          insertIndex = newMessages.length;
        }
        continue;
      }
      newMessages.push(m);
    }

    if (insertIndex !== -1) {
      newMessages.splice(insertIndex, 0, {
        id: `primary-sum-${sum.latestId}`,
        role: "custom",
        customType: "context-prune-primary",
        content: `【初级精简摘要】\n${sum.summaryText}`,
        display: true
      });
    }
    messages = newMessages;
  }

  // ---- Global Summary ----
  if (globalSummary) {
    const newMessages = [];
    let hasInsertedGlobal = false;

    for (const m of messages) {
      if (m.role === "system" || m.role === "developer") {
        newMessages.push(m);
        continue;
      }

      if (m.id && globalSummary.collapsedIds.has(m.id)) {
        if (!hasInsertedGlobal) {
          newMessages.push({
            id: `global-sum-${globalSummary.timestamp}`,
            role: "custom",
            customType: "context-prune-global",
            content: `【高级精简：世界线坍缩】\n${globalSummary.text}`,
            display: true
          });
          hasInsertedGlobal = true;
        }
        continue;
      }
      newMessages.push(m);
    }
    messages = newMessages;
  }

  return messages;
}

async function triggerPrimarySummary(ctx, pi, batches) {
  isPrimarySummarizing = true;
  ctx.ui?.notify(`pruner: 正在进行初级精简 (${batches.length} 个工具调用)...`, "info");

  try {
    const model = resolveModel(ctx);
    const complete = await getCompleteFn();
    const apiKey = await ctx.modelRegistry?.getApiKey(model);

    const serialized = batches.map(b => `Tool: ${b.name}\nArgs: ${JSON.stringify(b.args)}\nResult: ${b.result.slice(0, 2000)}`).join('\n\n---\n\n');

    const prompt = `你是一个总结助手。请将以下 AI 工具调用记录浓缩为简短的摘要。
仅保留：工具名、执行了什么、关键结果（成功/失败及核心数据）、未来需要的发现。
忽略琐碎的无用输出。

<tool-calls>
${serialized}
</tool-calls>`;

    const response = await complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, { apiKey, headers: model.headers });

    const summaryText = response.content.map(c => c.text).join("\n");
    const toolCallIds = batches.map(b => b.id);
    const latestId = toolCallIds[toolCallIds.length - 1];

    const data = { toolCallIds, latestId, summaryText };
    primarySummaries.push(data);
    pi.appendEntry("context-prune-primary-data", data);

    ctx.ui?.notify("pruner: 初级精简完成，工具输出已被折叠。", "info");
  } catch (err) {
    ctx.ui?.notify(`pruner: 初级精简失败 - ${err.message}`, "error");
  } finally {
    isPrimarySummarizing = false;
  }
}

async function triggerGlobalSummary(ctx, pi, projectedMessages) {
  isGlobalSummarizing = true;
  ctx.ui?.notify("pruner: 正在进行高级精简 (全局世界线坍缩)...", "info");

  try {
    const model = resolveModel(ctx);
    const complete = await getCompleteFn();
    const apiKey = await ctx.modelRegistry?.getApiKey(model);

    const textMessages = projectedMessages.map(m => {
      let content = "";
      if (Array.isArray(m.content)) {
        content = m.content.map(c => c.text || JSON.stringify(c)).join("\n");
      } else {
        content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      }
      return `[${m.role}] ${content}`;
    }).join("\n\n");

    const prompt = `请将以下所有的对话与执行历史，浓缩总结为"问题背景"和"当前进度"。
保留当前正在执行的任务目标、已确认的约束和接下来需要做的事情。
丢弃琐碎的尝试过程。

<history>
${textMessages}
</history>`;

    const response = await complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, { apiKey, headers: model.headers });

    const summaryText = response.content.map(c => c.text).join("\n");
    const collapsedIds = new Set(projectedMessages.map(m => m.id).filter(Boolean));

    const data = {
      text: summaryText,
      collapsedIds: Array.from(collapsedIds),
      timestamp: Date.now()
    };

    globalSummary = { ...data, collapsedIds };
    pi.appendEntry("context-prune-global-data", data);
    ctx.ui?.notify("pruner: 高级精简完成，历史已被折叠。", "info");
  } catch (err) {
    ctx.ui?.notify(`pruner: 高级精简失败 - ${err.message}`, "error");
  } finally {
    isGlobalSummarizing = false;
  }
}

// ===========================================================================
// Payload 稳定（仍保留，无关对话结构）
// ===========================================================================

export function stabilizeResponsesInput(input) {
  const callMap = new Map();
  let m = 0, f = 0, changed = false;

  const getCallId = (id) => {
    if (!callMap.has(id)) callMap.set(id, `call_${callMap.size}`);
    return callMap.get(id);
  };

  const next = input.map(i => {
    if (!i || typeof i !== "object") return i;
    let out = i;
    const upd = (k, v) => { if (out[k] !== v) { if (out === i) out = { ...i }; out[k] = v; changed = true; } };

    if (i.type === "message" && i.role === "assistant" && typeof i.id === "string") upd("id", `msg_${m++}`);
    if (i.type === "function_call") {
      if (typeof i.call_id === "string") upd("call_id", getCallId(i.call_id));
      if (typeof i.id === "string") upd("id", `fc_${f++}`);
    }
    if (i.type === "function_call_output" && typeof i.call_id === "string") upd("call_id", getCallId(i.call_id));
    return out;
  });
  return { input: next, changed };
}

export function stabilizeResponsesPayload(event) {
  const p = event.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  if (!["openai-responses", "azure-openai-responses"].includes(event.model?.api || "") && !(Array.isArray(p.input) && ("prompt_cache_key" in p || "store" in p))) return undefined;

  let changed = false;
  const next = { ...p };

  const key = process.env.GSD_HINTS_PROMPT_CACHE_KEY?.trim() || (() => {
    if (!Array.isArray(next.input)) return undefined;
    const text = next.input.filter(i => i && typeof i === "object" && (i.role === "system" || i.role === "developer"))
      .map(i => typeof i.content === "string" ? i.content : Array.isArray(i.content) ? i.content.map((b) => b?.text || "").join("\n") : "")
      .filter(Boolean).join("\n\n");
    return text ? `gsd-hints:${createHash("sha256").update(text).digest("hex").slice(0, 24)}` : undefined;
  })();

  if (key && next.prompt_cache_key !== key) { next.prompt_cache_key = key; changed = true; }

  if (Array.isArray(next.input)) {
    const { input, changed: c } = stabilizeResponsesInput(next.input);
    if (c) { next.input = input; changed = true; }
  }
  return changed ? next : undefined;
}

// ===========================================================================
// Plugin entry
// ===========================================================================

export default function contextPrunePlugin(pi) {
  pi.on("session_start", (event, ctx) => {
    primarySummaries = [];
    globalSummary = null;
    pendingToolCalls = [];
    lastContextMessages = [];
    isPrimarySummarizing = false;
    isGlobalSummarizing = false;

    const branch = ctx?.sessionManager?.getBranch?.() || [];
    for (const entry of branch) {
      if (entry.type === "custom") {
        if (entry.customType === "context-prune-primary-data") {
          primarySummaries.push(entry.data);
        } else if (entry.customType === "context-prune-global-data") {
          globalSummary = {
            ...entry.data,
            collapsedIds: new Set(entry.data.collapsedIds)
          };
        }
      }
    }
  });

  // ---- 投影：仅精简，无消息修复逻辑 ----
  pi.on("context", (event) => {
    const messages = event.messages || [];
    lastContextMessages = messages;
    return { messages: projectMessages(messages) };
  });

  pi.on("turn_end", (event, ctx) => {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const toolCalls = content.filter(b => b.type === "toolCall");
    const toolResults = event.toolResults || [];

    for (const tc of toolCalls) {
      const id = tc.id || tc.toolCallId;
      const res = toolResults.find(r => r.toolCallId === id || r.id === id);
      if (res) {
        pendingToolCalls.push({
          id,
          name: tc.name || tc.toolName,
          args: tc.arguments || tc.args || tc.input || {},
          result: Array.isArray(res.content) ? res.content.map(c => c.text || JSON.stringify(c)).join('\n') : String(res.content || "")
        });
      }
    }

    const usage = ctx?.getContextUsage?.();
    if (usage && usage.contextWindow > 0 && event.message?.stopReason !== "aborted" && event.message?.stopReason !== "error") {
      const tokens = usage.totalTokens || (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
      if (tokens / usage.contextWindow > 2/3 && !isGlobalSummarizing) {
        triggerGlobalSummary(ctx, pi, projectMessages(lastContextMessages));
      }
    }
  });

  // ---- 仅稳定 Payload，不涉及对话结构 ----
  pi.on("before_provider_request", (e) => {
    const r = stabilizeResponsesPayload(e);
    if (r) return r;
  });

  // ---- tools & commands ----
  pi.registerTool({
    name: "context_prune",
    description: "Summarize and prune preceding tool-call results to reduce context size. Call this after completing a batch of work.",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _sig, _onUpdate, ctx) => {
      if (pendingToolCalls.length > 0 && !isPrimarySummarizing) {
        triggerPrimarySummary(ctx, pi, [...pendingToolCalls]);
        pendingToolCalls.length = 0;
      } else if (pendingToolCalls.length > 0 && isPrimarySummarizing) {
        ctx.ui?.notify?.("pruner: 上一轮精简仍在进行中，等待下一轮处理。", "info");
      }
      return { content: [{ type: "text", text: "Context prune sidecar scheduled. Normal work can continue." }] };
    }
  });

  pi.registerCommand("pruner", {
    description: "Manage context-prune summarizer model",
    handler: async (args, ctx) => {
      if (args.length > 0) {
        summarizerModelId = args[0];
        saveSettings();
        ctx.ui?.notify(`pruner: 伴随模型已切换为 ${summarizerModelId}`, "info");
      } else {
        ctx.ui?.notify(`pruner: 当前伴随模型为 ${summarizerModelId}。用法: /pruner provider/model-id`, "info");
      }
    }
  });
}
