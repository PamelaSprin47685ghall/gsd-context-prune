import { loadHintSources, buildHintsBlock, injectHints } from "./src/hints.js";
import { stripCodebase, stripMessages } from "./src/codebase.js";
import { setCodebaseDir, getCodebaseDir, generateFileListing, injectListing } from "./src/listing.js";
import { stabilizeIds } from "./src/ids.js";
import { normalizeMessages } from "./src/normalize.js";
import {
  setSummarizerModelId, getSummarizerModelId, isSummarizing, hasPendingToolCalls,
  getPendingToolCalls, resetPendingToolCalls, getSummaries, restoreSummariesFromBranch,
  projectMessages, triggerPrimarySummary, triggerGlobalSummary, collectToolCall
} from "./src/summary.js";
import { loadDefaultModelId, saveModelId } from "./src/settings.js";

export { setCodebaseDir, generateFileListing, projectMessages, normalizeMessages, stabilizeIds, stripCodebase, loadHintSources, buildHintsBlock };

export function stabilizePayload(event) {
  const p = event.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return;

  const isResponses = Array.isArray(p.input);
  const messages = isResponses ? p.input : Array.isArray(p.messages) ? p.messages : null;
  if (!messages || messages.length < 2) return;

  let m = stripMessages(messages);
  m = injectListing(m);
  m = normalizeMessages(m, p.reasoning_effort);

  if (isResponses) {
    const input = stabilizeIds(m);
    return { ...p, input };
  }
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
    const withListing = injectListing(messages);
    return { messages: projectMessages(withListing) };
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

    let modified = stripMessages(messages);
    modified = injectHints(modified, getCodebaseDir());
    let result = p;
    if (modified !== messages) {
      result = isResponses ? { ...result, input: modified } : { ...result, messages: modified };
    }

    if (isResponses) {
      const input = stabilizeIds(modified);
      if (input !== modified) result = { ...result, input };
    }

    const msgs = isResponses ? result.input : result.messages;
    const normalized = normalizeMessages(msgs, p.reasoning_effort);
    if (normalized !== msgs) {
      result = isResponses ? { ...result, input: normalized } : { ...result, messages: normalized };
    }
    return result;
  });

  pi.registerTool({
    name: "context_prune",
    label: "Context Prune",
    description: "Summarize and prune preceding tool-call results to reduce context size. Call this after completing a batch of work.",
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
