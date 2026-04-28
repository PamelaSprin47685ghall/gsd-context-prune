import { loadHintSources, buildHintsBlock, injectHints } from "./src/hints.js";
import { buildCavemanBlock, buildCavemanReminder, injectCavemanBlock } from "./src/caveman.js";
import { stripCodebase, stripMessages } from "./src/codebase.js";
import { setCodebaseDir, getCodebaseDir, generateFileListing } from "./src/listing.js";
import { stabilizeIds } from "./src/ids.js";
import { normalizeMessages } from "./src/normalize.js";
import {
  setSummarizerModelId, getSummarizerModelId, isSummarizing, hasPendingToolCalls,
  getPendingToolCalls, resetPendingToolCalls, getSummaries, restoreSummariesFromBranch,
  projectMessages, triggerPrimarySummary, triggerGlobalSummary, collectToolCall
} from "./src/summary.js";
import { loadDefaultModelId, saveModelId } from "./src/settings.js";

export { setCodebaseDir, generateFileListing, projectMessages, normalizeMessages, stabilizeIds, stripCodebase, loadHintSources, buildHintsBlock, buildCavemanBlock, injectCavemanBlock };

function processPayload(payload, messages, isResponses) {
  const stripped = stripMessages(messages);
  const normalized = normalizeMessages(stripped, payload.reasoning_effort);
  if (isResponses) return stabilizeIds(normalized);
  return normalized;
}

export function stabilizePayload(event) {
  const p = event.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return;

  const isResponses = Array.isArray(p.input);
  const messages = isResponses ? p.input : Array.isArray(p.messages) ? p.messages : null;
  if (!messages || messages.length < 2) return;

  let m = processPayload(p, messages, isResponses);

  if (isResponses) return { ...p, input: m };
  return { ...p, messages: m };
}

export default function contextPrunePlugin(pi) {
  setSummarizerModelId(loadDefaultModelId());

  pi.on("session_start", (_event, ctx) => {
    restoreSummariesFromBranch(ctx?.sessionManager?.getBranch?.());
    ctx.ui.notify(
      `pruner: 已加载。伴随模型 ${getSummarizerModelId()}，会话摘要 ${getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("context", (event) => {
    const messages = event.messages || [];

    // Inherit model info from the latest assistant message so thinking blocks on
    // injected messages survive gsd-2's transformMessages cross-model gate.
    let modelInfo = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.provider && m.model) {
        modelInfo = { provider: m.provider, model: m.model, api: m.api };
        break;
      }
    }

    // Migrate top-level reasoning_content into content[].thinking blocks on all
    // assistant messages.  gsd-2's transformMessages strips top-level
    // reasoning_content before before_provider_request runs; wrapping it in a
    // thinking block earlier (here in context) preserves it.
    const migrated = messages.map(m => {
      if (m.role !== "assistant") return m;
      if (!m.reasoning_content) return m;
      const content = Array.isArray(m.content) ? [...m.content] : [];
      const thinkingIdx = content.findIndex(c => c.type === "thinking");
      if (thinkingIdx !== -1) {
        content[thinkingIdx] = {
          ...content[thinkingIdx],
          thinking: m.reasoning_content + "\n" + content[thinkingIdx].thinking,
        };
      } else {
        content.unshift({
          type: "thinking",
          thinking: m.reasoning_content,
          thinkingSignature: "reasoning_content",
        });
      }
      const { reasoning_content, ...rest } = m;
      return { ...rest, content };
    });

    // Backfill model info on existing messages whose thinking blocks would
    // otherwise be downgraded by transformMessages (isSameModel = false).
    const fixed = modelInfo
      ? migrated.map(m => {
        if (m.role !== "assistant") return m;
        if (m.provider) return m;
        if (!Array.isArray(m.content) || !m.content.some(b => b.type === "thinking")) return m;
        return { ...m, ...modelInfo };
      })
      : migrated;

    return { messages: projectMessages(fixed) };
  });

  pi.on("turn_end", (event, ctx) => {
    collectToolCall(event);
    const usage = ctx?.getContextUsage?.();
    if (usage?.contextWindow > 0 && event.message?.stopReason !== "aborted" && event.message?.stopReason !== "error") {
      const tokens = usage.totalTokens || (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
      if (tokens / usage.contextWindow > 2 / 3 && !isSummarizing())
        triggerGlobalSummary(ctx, pi, projectMessages(event.messages || []));
    }
  });

  pi.on("before_provider_request", (e) => {
    const p = e.payload;
    if (!p || typeof p !== "object") return;

    const isResponses = Array.isArray(p.input);
    const messages = isResponses ? p.input : Array.isArray(p.messages) ? p.messages : null;
    if (!messages) return;

    let modified = processPayload(p, messages, isResponses);
    modified = injectCavemanBlock(modified);
    modified = injectHints(modified, getCodebaseDir());

    // Inject caveman reminder + listing as the final assistant message so it
    // reaches the provider directly without going through gsd-2's transformMessages
    // (which runs between context and before_provider_request and would degrade
    // the thinking block to plain text if modelInfo is unavailable).
    for (let i = modified.length - 1; i >= 0; i--) {
      if (modified[i].role === "user") {
        modified[i].content = [
          ...modified[i].content,
          `<think>${buildCavemanReminder()}</think>`
        ];
      } else if (!modified[i].reasoning_content) {
        modified[i].reasoning_content = `<think>${buildCavemanReminder()}</think>`
      } else {
        modified[i].reasoning_content += `\n<think>${buildCavemanReminder()}</think>`;
      }
    }

    let result = p;
    if (modified !== messages) {
      result = isResponses ? { ...result, input: modified } : { ...result, messages: modified };
    }
    return result;
  });

  pi.registerTool({
    name: "context_prune",
    label: "Context Prune",
    description: "⚠️ 释放上下文窗口的救命工具。大型工具调用结果（文件读取、搜索、命令输出）会迅速填满上下文窗口，导致模型遗忘较早的指令、约束和决策。调用后将最近一批工具结果压缩为摘要，保留关键信息的同时释放 20-50% 上下文空间。\n\n何时必须调用：\n- 完成一批文件读取/搜索/命令执行后\n- 切换话题或进入新任务前\n- 感觉到上下文变重、推理变慢时\n\n调用时机越早越好、越频繁越好，没有任何惩罚。不调用的后果：上下文溢出 → 遗忘约束 → 推理退化 → 任务失败。",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _sig, _onUpdate, ctx) => {
      if (hasPendingToolCalls() && !isSummarizing()) {
        ctx.ui.notify(`pruner: 开始精简 ${getPendingToolCalls().length} 个工具调用...`, "info");
        triggerPrimarySummary(ctx, pi, [...getPendingToolCalls()]);
        resetPendingToolCalls();
      } else if (hasPendingToolCalls() && isSummarizing()) {
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
        setSummarizerModelId(arg);
        saveModelId(arg);
        ctx.ui.notify(`pruner: 伴随模型已切换为 ${arg}`, "info");
      } else {
        ctx.ui.notify(`pruner: 当前伴随模型为 ${getSummarizerModelId()}。用法: /pruner provider/model-id`, "info");
      }
    }
  });
}
