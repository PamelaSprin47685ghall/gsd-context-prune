import { buildStablePrompt, buildHintsBlock, loadHintSources } from "./src/inject.js";
import { generateFileListing } from "./src/fs.js";
import { loadDefaultModelId, saveModelId } from "./src/settings.js";
import {
  setSummarizerModelId, getSummarizerModelId, isSummarizing, hasPendingToolCalls,
  getPendingToolCalls, resetPendingToolCalls, getSummaries, restoreSummariesFromBranch,
  projectMessages, triggerPrimarySummary, triggerGlobalSummary, collectToolCall
} from "./src/summary.js";

export { generateFileListing, projectMessages, loadHintSources, buildHintsBlock };

export default function contextPrunePlugin(pi) {
  setSummarizerModelId(loadDefaultModelId());

  pi.on("session_start", (_event, ctx) => {
    restoreSummariesFromBranch(ctx?.sessionManager?.getBranch?.());
    ctx.ui.notify(
      `pruner: 已加载。伴随模型 ${getSummarizerModelId()}，会话摘要 ${getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("before_agent_start", (event) => {
    const stable = buildStablePrompt(event.systemPrompt);
    if (stable !== event.systemPrompt)
      return { systemPrompt: stable };
  });

  pi.on("context", (event) => {
    const msgs = event.messages || [];

    // Find the last assistant message with provider info (for model attribution)
    const last = msgs.findLast(m => m.role === "assistant" && m.provider && m.model);
    const modelInfo = last ? { provider: last.provider, model: last.model, api: last.api } : null;

    // Migrate reasoning_content into thinking blocks
    const migrated = msgs.map(m => {
      if (m.role !== "assistant" || !m.reasoning_content) return m;
      const content = Array.isArray(m.content) ? [...m.content] : [];
      const ti = content.findIndex(c => c.type === "thinking");
      if (ti !== -1)
        content[ti] = { ...content[ti], thinking: m.reasoning_content + "\n" + content[ti].thinking };
      else
        content.unshift({ type: "thinking", thinking: m.reasoning_content, thinkingSignature: "reasoning_content" });
      const { reasoning_content, ...rest } = m;
      return { ...rest, content };
    });

    // Attach model info to any thinking-bearing assistant that lacks it
    const fixed = modelInfo
      ? migrated.map(m => m.role !== "assistant" || m.provider || !Array.isArray(m.content) || !m.content.some(b => b?.type === "thinking") ? m : { ...m, ...modelInfo })
      : migrated;

    return { messages: projectMessages(fixed) };
  });

  pi.on("turn_end", (event, ctx) => {
    collectToolCall(event);
    const u = ctx?.getContextUsage?.();
    if (!u?.contextWindow || event.message?.stopReason === "aborted" || event.message?.stopReason === "error") return;
    const total = u.totalTokens || (u.input + u.output + u.cacheRead + u.cacheWrite);
    if (total / u.contextWindow > 2 / 3 && !isSummarizing())
      triggerGlobalSummary(ctx, pi, projectMessages(event.messages || []));
  });

  pi.on("before_provider_request", (e) => {
    // Strip random sessionId so same content hits same cache across sessions
    const p = e.payload;
    if (p && 'input' in p) delete p.prompt_cache_key;
    return p;
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
        ctx.ui.notify(`pruner: 当前伴随模型为 ${getSummarizerModelId()}。用法: /pruner provider/model - id`, "info");
      }
    }
  });
}
