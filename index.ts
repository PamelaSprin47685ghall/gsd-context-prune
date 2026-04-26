/**
 * context-prune — Pi extension entry point
 *
 * Wires together config, capture, sidecar summarization, projected branch
 * rewriting, query recovery, and commands.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch } from "./src/batch-capture.js";
import { summarizeBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { BranchRewriter } from "./src/branch-rewriter.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, pruneStatusText } from "./src/commands.js";
import type { ContextPruneConfig, CapturedBatch, RewriteEntryData } from "./src/types.js";
import { STATUS_WIDGET_ID, CONTEXT_PRUNE_TOOL_NAME, AGENTIC_AUTO_SYSTEM_PROMPT, DEFAULT_CONFIG, CUSTOM_TYPE_PROACTIVE_RESUME } from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { getProactiveCompactUsage, shouldProactivelyCompact } from "./src/proactive-compact.js";

const PLUGIN_NAME = "gsd-context-prune";

function logFlushDiagnostic(
  ctx: any,
  phase: string,
  cause: string,
  scenarioId: string,
  details?: Record<string, unknown>,
): void {
  const suffix = Object.entries(details ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

  const message = `[pruner] plugin=${PLUGIN_NAME} phase=${phase} cause=${cause} scenarioId=${scenarioId}${suffix ? ` ${suffix}` : ""}`;
  const notify = (ctx as { ui?: { notify?: unknown } } | undefined)?.ui?.notify;
  if (typeof notify === "function") {
    notify.call((ctx as { ui?: unknown })?.ui, message, "info");
  }
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
  const notifyFn = (ctx as { ui?: { notify?: unknown } } | undefined)?.ui?.notify;
  if (typeof notifyFn === "function") {
    notifyFn.call((ctx as { ui?: unknown })?.ui, message, level);
  }
}

export default function (pi: ExtensionAPI) {
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG },
  };

  const indexer = new ToolCallIndexer();
  const branchRewriter = new BranchRewriter();
  const statsAccum = new StatsAccumulator();
  const pendingBatches: CapturedBatch[] = [];

  let pendingGeneration = 0;
  let flushInFlight: Promise<void> | null = null;
  let flushRequestedWhileRunning = false;
  let proactiveCompactInFlight = false;
  let pendingCompactResetReason: string | null = null;

  const statusText = () => {
    if (flushInFlight) return "prune: summarizing sidecar…";
    if (pendingBatches.length > 0) return `prune: ${pendingBatches.length} pending`;
    return pruneStatusText(currentConfig.value, statsAccum.getStats());
  };

  const setCurrentStatus = (ctx: any) => {
    ctx.ui.setStatus(STATUS_WIDGET_ID, statusText());
  };

  const resetPendingBatches = (ctx: any, reason: string) => {
    pendingGeneration += 1;
    const droppedPendingBatches = pendingBatches.length;
    pendingBatches.length = 0;
    flushRequestedWhileRunning = false;

    logFlushDiagnostic(ctx, "queue-reset", "pending-generation-advanced", reason, {
      pendingGeneration,
      droppedPendingBatches,
      inFlight: flushInFlight ? "yes" : "no",
    });
  };

  const flushPending = async (ctx: any, scenarioId = "unspecified"): Promise<void> => {
    if (flushInFlight) {
      if (pendingBatches.length > 0) {
        flushRequestedWhileRunning = true;
      }
      logFlushDiagnostic(ctx, "flush-skip", "sidecar-already-running", scenarioId, {
        pendingGeneration,
        queuedBatches: pendingBatches.length,
      });
      setCurrentStatus(ctx);
      return;
    }

    if (pendingBatches.length === 0) {
      logFlushDiagnostic(ctx, "flush-skip", "no-pending-batches", scenarioId, {
        pendingGeneration,
      });
      return;
    }

    const drainGeneration = pendingGeneration;
    const batches = pendingBatches.splice(0);
    const batchCount = batches.length;
    const toolCallCount = batches.reduce((total, batch) => total + batch.toolCalls.length, 0);

    logFlushDiagnostic(ctx, "flush-start", "sidecar-batches-drained", scenarioId, {
      pendingGeneration: drainGeneration,
      batchCount,
      toolCallCount,
    });

    notify(ctx, `pruner: sidecar summarization started for ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}.`, "info");
    ctx.ui.setStatus(STATUS_WIDGET_ID, "prune: summarizing sidecar…");

    const run = (async () => {
      const result = await summarizeBatches(batches, currentConfig.value, ctx);

      if (drainGeneration !== pendingGeneration) {
        logFlushDiagnostic(ctx, "flush-end", "discarded-stale-generation", scenarioId, {
          drainedGeneration: drainGeneration,
          currentGeneration: pendingGeneration,
          batchCount,
          toolCallCount,
        });
        return;
      }

      if (!result) {
        logFlushDiagnostic(ctx, "flush-end", "summarizer-returned-null", scenarioId, {
          pendingGeneration,
          batchCount,
          toolCallCount,
        });
        notify(ctx, "pruner: sidecar summarization failed; history was not replaced.", "error");
        return;
      }

      statsAccum.add(result.usage);
      statsAccum.persist(pi);

      for (const batch of batches) {
        indexer.addBatch(batch, pi);
      }

      const allToolCallIds = batches.flatMap((batch) => batch.toolCalls.map((toolCall) => toolCall.toolCallId));
      const allToolNames = batches.flatMap((batch) => batch.toolCalls.map((toolCall) => toolCall.toolName));
      const replacement: RewriteEntryData = {
        summaryText: result.summaryText,
        toolCallIds: allToolCallIds,
        toolNames: allToolNames,
        turnIndex: batches[0].turnIndex,
        timestamp: batches[batches.length - 1].timestamp,
        completedAt: Date.now(),
      };

      branchRewriter.addReplacement(replacement, pi);

      logFlushDiagnostic(ctx, "flush-end", "sidecar-history-replaced", scenarioId, {
        pendingGeneration,
        batchCount,
        toolCallCount: allToolCallIds.length,
      });
      notify(ctx, `pruner: sidecar summarization complete — ${allToolCallIds.length} tool result${allToolCallIds.length === 1 ? "" : "s"} replaced in projected history.`, "info");
    })()
      .catch((error: any) => {
        logFlushDiagnostic(ctx, "flush-end", "sidecar-threw", scenarioId, {
          pendingGeneration,
          batchCount,
          toolCallCount,
          error: error?.message ?? String(error),
        });
        notify(ctx, `pruner: sidecar summarization failed: ${error?.message ?? String(error)}`, "error");
      })
      .finally(() => {
        if (flushInFlight === run) {
          flushInFlight = null;
        }
        setCurrentStatus(ctx);
        const shouldContinue = flushRequestedWhileRunning && pendingBatches.length > 0;
        flushRequestedWhileRunning = false;
        if (shouldContinue) {
          void flushPending(ctx, `${scenarioId}-queued`);
        }
      });

    flushInFlight = run;
  };

  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((toolName: string) => toolName !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  const contextWindow = (ctx: any): number => {
    const modelWindow = ctx.model?.contextWindow;
    if (typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0) return modelWindow;

    const usageWindow = ctx.getContextUsage?.()?.contextWindow;
    return typeof usageWindow === "number" && Number.isFinite(usageWindow) && usageWindow > 0 ? usageWindow : 0;
  };

  const maybeProactiveCompact = async (event: any, ctx: any): Promise<void> => {
    if (proactiveCompactInFlight) return;

    const currentContextUsage = ctx.getContextUsage?.();
    const usage = getProactiveCompactUsage(event.message, contextWindow(ctx), currentContextUsage);
    if (!shouldProactivelyCompact(usage)) return;

    const shouldResumeInterruptedToolTurn = Boolean(event.toolResults && event.toolResults.length > 0);
    proactiveCompactInFlight = true;
    pendingCompactResetReason = "proactive-threshold";

    logFlushDiagnostic(ctx, "compact-start", "projected-context-threshold", "turn_end", {
      turnIndex: event.turnIndex,
      contextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: (usage.ratio * 100).toFixed(2),
      replacementCount: branchRewriter.getReplacementCount(),
      resumeAfterCompact: shouldResumeInterruptedToolTurn ? "yes" : "no",
    });

    await new Promise<void>((resolve) => {
      ctx.compact({
        customInstructions: "Compact the extension-projected context exactly as prepared; preserve the current task state, recent user intent, and recovery handles.",
        onComplete: () => {
          logFlushDiagnostic(ctx, "compact-end", "projected-context-compacted", "turn_end", {
            turnIndex: event.turnIndex,
            resumeAfterCompact: shouldResumeInterruptedToolTurn ? "yes" : "no",
          });

          if (shouldResumeInterruptedToolTurn) {
            pi.sendMessage({
              customType: CUSTOM_TYPE_PROACTIVE_RESUME,
              content: "Pruner proactively compacted the projected context after a tool-result turn exceeded 66.66% context usage. Continue the interrupted agent loop from this compacted state; do not ask the user for confirmation unless the original task requires it.",
              display: true,
              details: {
                turnIndex: event.turnIndex,
                contextTokens: usage.tokens,
                contextWindow: usage.contextWindow,
                percent: Number((usage.ratio * 100).toFixed(2)),
              },
            }, { triggerTurn: true });
            logFlushDiagnostic(ctx, "compact-resume", "visible-message-triggered", "turn_end", {
              turnIndex: event.turnIndex,
            });
          }

          resolve();
        },
        onError: (error: Error) => {
          proactiveCompactInFlight = false;
          pendingCompactResetReason = null;
          logFlushDiagnostic(ctx, "compact-end", "projected-context-compact-failed", "turn_end", {
            turnIndex: event.turnIndex,
            error: error.message,
          });
          notify(ctx, `pruner: proactive compact failed: ${error.message}`, "warning");
          resolve();
        },
      });
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    resetPendingBatches(ctx, "session-start");

    currentConfig.value = await loadConfig();
    indexer.reconstructFromSession(ctx);
    branchRewriter.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);

    setCurrentStatus(ctx);
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  pi.on("session_tree", async (_event, ctx) => {
    resetPendingBatches(ctx, "session-tree");
    indexer.reconstructFromSession(ctx);
    branchRewriter.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    setCurrentStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    resetPendingBatches(ctx, "session-switch");
    indexer.reconstructFromSession(ctx);
    branchRewriter.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    setCurrentStatus(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    resetPendingBatches(ctx, "session-fork");
    indexer.reconstructFromSession(ctx);
    branchRewriter.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    setCurrentStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      if (currentConfig.value.pruneOn === "agent-message") {
        void flushPending(ctx, "agent-message-text-turn");
      }
    } else {
      const batch = captureBatch(event.message, event.toolResults, event.turnIndex, Date.now());
      if (batch.toolCalls.length > 0) {
        pendingBatches.push(batch);
        logFlushDiagnostic(ctx, "queue-enqueue", "captured-tool-batch", "turn_end", {
          pendingGeneration,
          pendingCount: pendingBatches.length,
          turnIndex: batch.turnIndex,
          toolCallCount: batch.toolCalls.length,
          pruneOn: currentConfig.value.pruneOn,
        });

        if (currentConfig.value.pruneOn === "every-turn") {
          void flushPending(ctx, "every-turn");
        } else {
          let trigger: string;
          switch (currentConfig.value.pruneOn) {
            case "on-context-tag":
              trigger = "next context_tag";
              break;
            case "agent-message":
              trigger = "agent's next text response";
              break;
            case "agentic-auto":
              trigger = "agent calling context_prune";
              break;
            default:
              trigger = "/pruner now";
              break;
          }

          setCurrentStatus(ctx);
          ctx.ui.notify(
            `pruner: ${pendingBatches.length} turn${pendingBatches.length === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
            "info"
          );
        }
      }
    }

    await maybeProactiveCompact(event, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    void flushPending(ctx, "context-tag");
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (pendingBatches.length === 0) return;
    void flushPending(ctx, "agent-end-safety-net");
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;
    const { preparation } = event;

    const replaceInList = (messages: any[]) => {
      const insertedSummaryIds = new Set<string>();
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg?.role === "toolResult") {
          const replacement = branchRewriter.getReplacementForToolCallId(msg.toolCallId);
          if (replacement) {
            if (!insertedSummaryIds.has(replacement.id)) {
              messages[i] = branchRewriter.toSummaryMessage(replacement);
              insertedSummaryIds.add(replacement.id);
            } else {
              // Already inserted this summary for a previous tool result in this batch.
              // Remove this redundant result.
              messages.splice(i, 1);
              i--;
            }
          }
        }
      }
    };

    if (preparation.messagesToSummarize) {
      replaceInList(preparation.messagesToSummarize);
    }
    if (preparation.turnPrefixMessages) {
      replaceInList(preparation.turnPrefixMessages);
    }

    return undefined;
  });

  pi.on("session_compact", async (event, ctx) => {
    const droppedReplacementCount = branchRewriter.getReplacementCount();
    const resetReason = pendingCompactResetReason ?? (event.fromExtension ? "extension-compact" : "session-compact");
    proactiveCompactInFlight = false;
    pendingCompactResetReason = null;
    resetPendingBatches(ctx, "session-compact");
    branchRewriter.resetAfterCompact(pi, resetReason);
    logFlushDiagnostic(ctx, "rewrite-reset", "official-compact-completed", "session_compact", {
      fromExtension: event.fromExtension ? "yes" : "no",
      droppedReplacementCount,
      resetReason,
    });
    setCurrentStatus(ctx);
  });

  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;
    if (branchRewriter.getReplacementCount() === 0) return undefined;
    return { messages: branchRewriter.project(event.messages) };
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;

    const currentPrompt = event.systemPrompt ?? "";
    if (currentPrompt.includes("[Context Prune — Agentic Auto Mode]")) {
      return undefined; // Already injected
    }

    return { systemPrompt: `${currentPrompt}\n\n${AGENTIC_AUTO_SYSTEM_PROMPT}` };
  });

  registerQueryTool(pi, indexer);
  registerContextPruneTool(pi, flushPending);
  registerCommands(pi, currentConfig, flushPending, syncToolActivation, () => statsAccum.getStats(), indexer);
}
