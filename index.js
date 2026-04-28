import { buildStablePrompt, buildHintsBlock, loadHintSources } from "./src/inject.js";
import { generateFileListing } from "./src/fs.js";
import { loadDefaultModelId, saveModelId } from "./src/settings.js";
import { createSummarizer } from "./src/summary.js";

export { generateFileListing, createSummarizer, loadHintSources, buildHintsBlock };

export default function contextPrunePlugin(pi) {
  const sz = createSummarizer();
  sz.setSummarizerModelId(loadDefaultModelId());

  const handleSessionChange = (ctx) => {
    sz.restoreSummariesFromBranch(ctx?.sessionManager?.getBranch?.());
    sz.resetPendingToolCalls();
  };

  pi.on("session_start", (_event, ctx) => {
    handleSessionChange(ctx);
    ctx.ui.notify(
      `pruner: 已加载。伴随模型 ${sz.getSummarizerModelId()}，会话摘要 ${sz.getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("session_switch", (_event, ctx) => {
    handleSessionChange(ctx);
    ctx.ui.notify(
      `pruner: 已切换会话。伴随模型 ${sz.getSummarizerModelId()}，会话摘要 ${sz.getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("session_fork", (_event, ctx) => {
    handleSessionChange(ctx);
    ctx.ui.notify(
      `pruner: 已分叉会话。伴随模型 ${sz.getSummarizerModelId()}，会话摘要 ${sz.getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("session_tree", (_event, ctx) => {
    handleSessionChange(ctx);
    ctx.ui.notify(
      `pruner: 已树形切换会话。伴随模型 ${sz.getSummarizerModelId()}，会话摘要 ${sz.getSummaries().length} 条已恢复。`,
      "info"
    );
  });

  pi.on("before_agent_start", (event, ctx) => {
    const { systemPrompt, errors } = buildStablePrompt(event.systemPrompt);
    if (errors.length > 0 && ctx?.ui)
      ctx.ui.notify(`pruner: HINTS 加载警告 — ${errors.join("; ")}`, "warning");
    if (systemPrompt !== event.systemPrompt)
      return { systemPrompt };
  });

  pi.on("context", (event) => {
    const msgs = event.messages || [];

    const last = msgs.findLast(m => m.role === "assistant" && m.provider && m.model);
    const modelInfo = last ? { provider: last.provider, model: last.model, api: last.api } : null;

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

    const fixed = modelInfo
      ? migrated.map(m => m.role !== "assistant" || m.provider || !Array.isArray(m.content) || !m.content.some(b => b?.type === "thinking") ? m : { ...m, ...modelInfo })
      : migrated;

    return { messages: sz.projectMessages(fixed) };
  });

  pi.on("turn_end", (event, ctx) => {
    sz.collectToolCall(event);
    const u = ctx?.getContextUsage?.();
    if (!u?.contextWindow || event.message?.stopReason === "aborted" || event.message?.stopReason === "error") return;
    const total = u.totalTokens || (u.input + u.output + u.cacheRead + u.cacheWrite);
    if (total / u.contextWindow > 2 / 3 && !sz.isSummarizing())
      sz.triggerGlobalSummary(ctx, pi, sz.projectMessages(event.messages || []));
  });

  pi.on("before_provider_request", (e) => {
    const p = e.payload;
    if (!p) return p;

    const msgs = 'input' in p ? p.input : p.messages;
    if (!Array.isArray(msgs)) return p;

    const model = p.model || "";
    const isAnthropic = /claude/i.test(model) || /anthropic/i.test(p.provider || "");

    const shallow = msgs.map(m => (m && typeof m === "object") ? { ...m } : m);
    if ("input" in p) p.input = shallow; else p.messages = shallow;

    if (!isAnthropic) {
      for (const m of shallow)
        if (m && m.role === "assistant" && !("reasoning_content" in m))
          m.reasoning_content = "";
    }

    if ("input" in p) delete p.prompt_cache_key;
    return p;
  });

  pi.registerTool({
    name: "context_prune",
    label: "Context Prune",
    description: "⚠️ 释放上下文窗口的救命工具。大型工具调用结果（文件读取、搜索、命令输出）会迅速填满上下文窗口，导致模型遗忘较早的指令、约束和决策。调用后将最近一批工具结果压缩为摘要，保留关键信息的同时释放 20-50% 上下文空间。\n\n何时必须调用：\n- 完成一批文件写入/搜索/命令执行后\n- 切换话题或进入新任务前\n- 感觉到上下文变重、推理变慢时\n\n调用时机越早越好、越频繁越好，没有任何惩罚，但是读取了代码原文，还需要精确原文不能压缩的时候不调用。不调用的后果：上下文溢出 → 遗忘约束 → 推理退化 → 任务失败。",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _sig, _onUpdate, ctx) => {
      if (sz.hasPendingToolCalls() && !sz.isSummarizing()) {
        ctx.ui.notify(`pruner: 开始精简 ${sz.getPendingToolCalls().length} 个工具调用...`, "info");
        sz.triggerPrimarySummary(ctx, pi, [...sz.getPendingToolCalls()]);
        sz.resetPendingToolCalls();
      } else if (sz.hasPendingToolCalls() && sz.isSummarizing()) {
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
        sz.setSummarizerModelId(arg);
        const saved = saveModelId(arg);
        ctx.ui.notify(
          saved
            ? `pruner: 伴随模型已切换为 ${arg}`
            : `pruner: 模型已切换为 ${arg}，但持久化失败`,
          saved ? "info" : "warning"
        );
      } else {
        ctx.ui.notify(`pruner: 当前伴随模型为 ${sz.getSummarizerModelId()}。用法: /pruner provider/model - id`, "info");
      }
    }
  });
}
