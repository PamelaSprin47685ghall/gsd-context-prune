let summarizerModelId = "default";
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
    throw new Error("Cannot import @gsd/pi-ai. " + err.message);
  }
}

function projectMessages(rawMessages) {
  let messages = [...rawMessages];

  // 1. 初级精简投影 (Primary Pruning)
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

  // 2. 高级精简投影 (Global Summary)
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

    const prompt = `请将以下所有的对话与执行历史，浓缩总结为“问题背景”和“当前进度”。
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

  pi.on("context", (event) => {
    lastContextMessages = event.messages || [];
    return { messages: projectMessages(lastContextMessages) };
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

  pi.registerTool({
    name: "context_prune",
    description: "Summarize and prune preceding tool-call results to reduce context size. Call this after completing a batch of work.",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _sig, _onUpdate, ctx) => {
      if (pendingToolCalls.length > 0) {
        triggerPrimarySummary(ctx, pi, [...pendingToolCalls]);
        pendingToolCalls.length = 0;
      }
      return { content: [{ type: "text", text: "Context prune sidecar scheduled. Normal work can continue." }] };
    }
  });

  pi.registerCommand("pruner", {
    description: "Manage context-prune summarizer model",
    handler: async (args, ctx) => {
      if (args.length > 0) {
        summarizerModelId = args[0];
        ctx.ui?.notify(`pruner: 伴随模型已切换为 ${summarizerModelId}`, "info");
      } else {
        ctx.ui?.notify(`pruner: 当前伴随模型为 ${summarizerModelId}。用法: /pruner provider/model-id`, "info");
      }
    }
  });
}
