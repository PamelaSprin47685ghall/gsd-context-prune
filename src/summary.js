export function createSummarizer() {
  const state = {
    summaries: [],
    pendingToolCalls: [],
    summarizing: false,
    summarizerModelId: "default",
    summaryQueue: Promise.resolve(),
    queuedGlobalSignature: null,
    lastGlobalSignature: null,
  };

  function setSummarizerModelId(id) { state.summarizerModelId = id; }
  function getSummarizerModelId() { return state.summarizerModelId; }
  function isSummarizing() { return state.summarizing; }
  function hasPendingToolCalls() { return state.pendingToolCalls.length > 0; }
  function getPendingToolCalls() { return state.pendingToolCalls; }
  function resetPendingToolCalls() { state.pendingToolCalls.length = 0; }
  function getSummaries() { return state.summaries; }

  function tryStartSummarizing() {
    if (state.summarizing) return false;
    state.summarizing = true;
    return true;
  }

  function resetState() {
    state.summaries.length = 0;
    state.pendingToolCalls.length = 0;
    state.summarizing = false;
    state.summarizerModelId = "default";
    state.summaryQueue = Promise.resolve();
    state.queuedGlobalSignature = null;
    state.lastGlobalSignature = null;
  }

  function restoreSummariesFromBranch(branchEntries) {
    state.summaries = [];
    let latestGlobal = null;
    for (const entry of branchEntries || []) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "context-prune-primary-data")
        state.summaries.push({ type: "primary", ...entry.data, toolCallIds: entry.data.toolCallIds });
      if (entry.customType === "context-prune-global-data")
        latestGlobal = { type: "global", ...entry.data, collapsedIds: new Set(entry.data.collapsedIds) };
    }
    if (latestGlobal) {
      state.summaries = state.summaries.filter(s => s.type !== "global");
      state.summaries.push(latestGlobal);
      const globalIds = [...latestGlobal.collapsedIds];
      state.lastGlobalSignature = globalIds.length > 0 ? `${globalIds.length}:${globalIds[globalIds.length - 1]}` : null;
    } else {
      state.lastGlobalSignature = null;
    }
    state.queuedGlobalSignature = null;
    state.summaryQueue = Promise.resolve();
  }

  function projectMessages(messages) {
    let result = messages;

    const primarySummaries = state.summaries.filter(s => s.type === "primary");
    if (primarySummaries.length > 0) {
      const toClear = new Map();
      for (const s of primarySummaries) {
        for (const id of s.toolCallIds) toClear.set(id, null);
        toClear.set(s.latestId, s.text);
      }
      result = result.map(m => {
        if (m.role !== "toolResult") return m;
        const id = m.toolCallId || m.id;
        const text = toClear.get(id);
        if (text === undefined) return m;
        return text !== null
          ? { ...m, content: [{ type: "text", text: `【初级精简摘要】\n${text}` }] }
          : { ...m, content: [] };
      });
    }

    for (const s of state.summaries) {
      if (s.type !== "global") continue;
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
          kept.push({ ...m, content: [] });
          continue;
        }
        kept.push(m);
      }
      result = kept;
    }

    return result;
  }

  function collectToolCallBatches(batches) {
    return batches.map(b =>
      `Tool: ${b.name}\nArgs: ${JSON.stringify(b.args)}\nResult: ${b.result || ""}`
    ).join("\n\n---\n\n");
  }

  async function triggerPrimarySummary(ctx, pi, batches) {
    if (!tryStartSummarizing()) {
      ctx.ui.notify("pruner: 上一轮精简仍在进行中，跳过本次。", "info");
      return;
    }
    ctx.ui.notify(`pruner: 正在进行初级精简 (${batches.length} 个工具调用)...`, "info");
    try {
      const model = state.summarizerModelId === "default" ? ctx.model
        : ctx.modelRegistry?.find(...state.summarizerModelId.split("/")) || ctx.model;
      const mod = await import("@gsd/pi-ai");
      const apiKey = await ctx.modelRegistry?.getApiKey(model);
      const text = collectToolCallBatches(batches);
      const prompt = "你是一个总结助手。请将以下 AI 工具调用记录浓缩为简短的摘要。\n" +
        "仅保留：工具名、执行了什么、关键结果（成功/失败及核心数据）、未来需要的发现。\n" +
        "忽略琐碎的无用输出。\n\n<tool-calls>\n" + text + "\n</tool-calls>";
      const res = await mod.complete(model, {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
      }, { apiKey, headers: model.headers });
      const summaryText = res.content.map(c => c.text).join("\n");
      const toolCallIds = batches.map(b => b.id);
      const latestId = toolCallIds[toolCallIds.length - 1];
      state.summaries.push({ type: "primary", toolCallIds, latestId, text: summaryText });
      pi.appendEntry("context-prune-primary-data", { toolCallIds, latestId, text: summaryText });
      ctx.ui.notify("pruner: 初级精简完成，工具输出已被折叠。", "success");
    } catch (err) {
      ctx.ui.notify(`pruner: 初级精简失败 - ${err.message}`, "error");
    } finally { state.summarizing = false; }
  }

  function contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map(b => {
      if (typeof b.text === "string") return b.text;
      if (b.type) return `[${b.type}]`;
      return "";
    }).join("\n");
  }

  function flattenMessages(messages) {
    return messages.map(m => `[${m.role}] ${contentText(m.content)}`).join("\n\n");
  }

  async function triggerGlobalSummary(ctx, pi, projectedMessages) {
    const collapsedIds = projectedMessages.map(m => m.id).filter(Boolean);
    if (collapsedIds.length === 0) return;

    const signature = `${collapsedIds.length}:${collapsedIds[collapsedIds.length - 1]}`;
    if (signature === state.lastGlobalSignature || signature === state.queuedGlobalSignature) return;

    state.queuedGlobalSignature = signature;

    state.summaryQueue = state.summaryQueue.catch(() => {}).then(async () => {
      if (!tryStartSummarizing()) {
        ctx?.ui?.notify("pruner: 上一轮精简仍在进行中，跳过本次全局精简。", "info");
        return;
      }
      ctx?.ui?.notify("pruner: 正在进行高级精简 (全局世界线坍缩)...", "info");
      try {
        const model = state.summarizerModelId === "default" ? ctx.model
          : ctx.modelRegistry?.find(...state.summarizerModelId.split("/")) || ctx.model;
        let mod;
        try {
          mod = await import("@gsd/pi-ai");
        } catch (err) {
          ctx?.ui?.notify(`pruner: 无法加载 @gsd/pi-ai 模块 - ${err.message}`, "error");
          return;
        }
        const apiKey = await ctx.modelRegistry?.getApiKey(model);
        const text = flattenMessages(projectedMessages);
        const prompt = "请将以下所有的对话与执行历史，浓缩总结为\"问题背景\"和\"当前进度\"。\n" +
          "保留当前正在执行的任务目标、已确认的约束和接下来需要做的事情。\n" +
          "丢弃琐碎的尝试过程。\n\n<history>\n" + text + "\n</history>";
        const res = await mod.complete(model, {
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
        }, { apiKey, headers: model.headers });
        const summaryText = res.content.map(c => c.text).join("\n");
        const collapsedIdSet = new Set(collapsedIds);
        const timestamp = Date.now();
        state.summaries = state.summaries.filter(s => s.type !== "global");
        state.summaries.push({ type: "global", collapsedIds: collapsedIdSet, text: summaryText, timestamp });
        pi.appendEntry("context-prune-global-data", { collapsedIds, text: summaryText, timestamp });
        state.lastGlobalSignature = signature;
        ctx?.ui?.notify("pruner: 高级精简完成，历史已被折叠。", "success");
      } catch (err) {
        ctx?.ui?.notify(`pruner: 高级精简失败 - ${err.message}`, "error");
      } finally {
        state.summarizing = false;
        if (state.queuedGlobalSignature === signature) state.queuedGlobalSignature = null;
      }
    });

    return state.summaryQueue;
  }

  function collectToolCall(event) {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const toolCalls = content.filter(b => b.type === "toolCall");
    const toolResults = event.toolResults || [];
    const toolResultById = new Map();

    for (const toolResult of toolResults) {
      const id = toolResult.toolCallId || toolResult.id;
      if (id && !toolResultById.has(id)) toolResultById.set(id, toolResult);
    }

    for (const tc of toolCalls) {
      const id = tc.id || tc.toolCallId;
      const res = toolResultById.get(id);
      if (res) {
        state.pendingToolCalls.push({
          id, name: tc.name || tc.toolName,
          args: tc.arguments || tc.args || tc.input || {},
          result: Array.isArray(res.content)
            ? res.content.map(c => c.text || JSON.stringify(c)).join("\n")
            : String(res.content || "")
        });
      }
    }
  }

  return {
    setSummarizerModelId, getSummarizerModelId, isSummarizing,
    hasPendingToolCalls, getPendingToolCalls, resetPendingToolCalls,
    getSummaries, resetState, restoreSummariesFromBranch,
    projectMessages, triggerPrimarySummary, triggerGlobalSummary,
    collectToolCall,
  };
}
