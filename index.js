import { loadDefaultModelId, saveModelId } from "./src/settings.js";
import { createSummarizer } from "./src/summary.js";

export default function contextPrunePlugin(pi) {
  const sz = createSummarizer();
  sz.setSummarizerModelId(loadDefaultModelId());

  const handleSessionChange = (eventType, ctx) => {
    sz.restoreSummariesFromBranch(ctx?.sessionManager?.getBranch?.());
    sz.resetPendingToolCalls();

    const messages = {
      session_start: "已加载",
      session_switch: "已切换会话",
      session_fork: "已分叉会话",
      session_tree: "已树形切换会话"
    };

    ctx.ui.notify(
      `pruner: ${messages[eventType]}。伴随模型 ${sz.getSummarizerModelId()}，会话摘要 ${sz.getSummaries().length} 条已恢复。`,
      "info"
    );
  };

  const sessionEvents = ["session_start", "session_switch", "session_fork", "session_tree"];
  for (const event of sessionEvents) {
    pi.on(event, (_event, ctx) => handleSessionChange(event, ctx));
  }

  // ── Context: project cached summaries into message stream ──
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

    const projected = sz.projectMessages(fixed);
    return { messages: projected };
  });

  // ── Turn end: collect tool calls; trigger /compact at high context usage ──
  pi.on("turn_end", (event, ctx) => {
    sz.collectToolCall(event);
    const u = ctx?.getContextUsage?.();
    if (!u?.contextWindow || u.percent === null || event.message?.stopReason === "aborted" || event.message?.stopReason === "error") return;

    if (u.percent > 66.66) {
      pi.sendUserMessage("/compact");

      // If this turn_end is NOT also agent_end (message has tool calls or
      // pauseTurn), keep the agent going after /compact finishes.
      const willContinue = event.message?.content?.some(c => c.type === "toolCall")
        || event.message?.stopReason === "pauseTurn";
      if (willContinue) {
        setTimeout(() => pi.retryLastTurn(), 0);
      }
    }
  });

  // ── User input: auto-trigger primary summary for pending tool calls ──
  // Every new turn (not steer, not follow-up) is an opportunity to compress
  // previous tool output before the agent processes the new request.
  pi.on("input", (event, ctx) => {
    if (sz.hasPendingToolCalls() && !sz.isSummarizing()) {
      sz.triggerPrimarySummary(ctx, pi, [...sz.getPendingToolCalls()]);
    }
    return { action: "continue" };
  });


  // ── Slash command: switch summarizer model ──
  pi.registerCommand("pruner", {
    description: "Manage context-prune summarizer model",
    handler: async (arg, ctx) => {
      if (arg.length > 0) {
        sz.setSummarizerModelId(arg);
        const saved = saveModelId(arg);
        ctx?.ui?.notify(
          saved
            ? `pruner: 伴随模型已切换为 ${arg}`
            : `pruner: 模型已切换为 ${arg}，但持久化失败`,
          saved ? "info" : "warning"
        );
      } else {
        ctx?.ui?.notify(`pruner: 当前伴随模型为 ${sz.getSummarizerModelId()}。用法: /pruner provider/model-id`, "info");
      }
    }
  });
}

export { createSummarizer };
