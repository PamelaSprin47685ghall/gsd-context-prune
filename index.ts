/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save ~/.pi/agent/context-prune/settings.json
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch } from "./src/batch-capture.js";
import { summarizeBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, pruneStatusText } from "./src/commands.js";
import type { ContextPruneConfig, CapturedBatch } from "./src/types.js";
import { STATUS_WIDGET_ID, CONTEXT_PRUNE_TOOL_NAME, AGENTIC_AUTO_SYSTEM_PROMPT, DEFAULT_CONFIG } from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";

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

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];

  // Increments whenever branch/session lifecycle changes to invalidate stale in-flight flushes.
  let pendingGeneration = 0;

  // Serializes flushes so queue draining + index writes do not overlap.
  let flushInFlight: Promise<void> | null = null;

  const resetPendingBatches = (ctx: any, reason: "session-start" | "session-tree") => {
    pendingGeneration += 1;
    const droppedPendingBatches = pendingBatches.length;
    pendingBatches.length = 0;

    logFlushDiagnostic(ctx, "queue-reset", "pending-generation-advanced", reason, {
      pendingGeneration,
      droppedPendingBatches,
      inFlight: flushInFlight ? "yes" : "no",
    });
  };

  // Summarizes + indexes all pending batches in a single LLM call and injects steer messages.
  // Called immediately in "every-turn" mode, by context_prune in "agentic-auto" mode, and deferred otherwise.
  const flushPending = async (ctx: any, scenarioId = "unspecified"): Promise<void> => {
    if (flushInFlight) {
      logFlushDiagnostic(ctx, "flush-await", "existing-flush-in-flight", scenarioId, {
        pendingGeneration,
        queuedBatches: pendingBatches.length,
      });
      await flushInFlight;
    }

    if (pendingBatches.length === 0) {
      logFlushDiagnostic(ctx, "flush-skip", "no-pending-batches", scenarioId, {
        pendingGeneration,
      });
      return;
    }

    const drainGeneration = pendingGeneration;
    const batches = pendingBatches.splice(0); // drain atomically
    const batchCount = batches.length;
    const toolCallCount = batches.reduce((total, batch) => total + batch.toolCalls.length, 0);

    logFlushDiagnostic(ctx, "flush-start", "pending-batches-drained", scenarioId, {
      pendingGeneration: drainGeneration,
      batchCount,
      toolCallCount,
    });

    const run = (async () => {
      ctx.ui.setStatus(STATUS_WIDGET_ID, "prune: summarizing…");

      // Batch all pending batches into a single LLM call
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

      if (result) {
        // Accumulate token/cost stats from this summarizer call
        statsAccum.add(result.usage);
        statsAccum.persist(pi);

        // Index ALL batches and send one combined summary message
        for (const batch of batches) {
          indexer.addBatch(batch, pi);
        }

        const allToolCallIds = batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId));
        const allToolNames = batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolName));

        pi.sendMessage(
          {
            customType: "context-prune-summary",
            content: result.summaryText,
            display: true,
            details: {
              toolCallIds: allToolCallIds,
              toolNames: allToolNames,
              turnIndex: batches[0].turnIndex, // first turn of the batch
              timestamp: batches[batches.length - 1].timestamp, // last timestamp
            },
          },
          { deliverAs: "steer" }
        );

        logFlushDiagnostic(ctx, "flush-end", "summary-indexed", scenarioId, {
          pendingGeneration,
          batchCount,
          toolCallCount: allToolCallIds.length,
        });
        return;
      }

      logFlushDiagnostic(ctx, "flush-end", "summarizer-returned-null", scenarioId, {
        pendingGeneration,
        batchCount,
        toolCallCount,
      });
    })();

    flushInFlight = run;
    try {
      await run;
    } finally {
      if (flushInFlight === run) {
        flushInFlight = null;
      }
      ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, statsAccum.getStats()));
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Invalidate any in-flight flush spawned by the previous session tree.
    resetPendingBatches(ctx, "session-start");

    // Load config from ~/.pi/agent/context-prune/settings.json
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Update footer status
    ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, statsAccum.getStats()));

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    // Pending batches belong to the old branch; also invalidates stale in-flight flushes.
    resetPendingBatches(ctx, "session-tree");

    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only turn: the agent sent a final message with no tool calls.
      // In "agent-message" mode, this is the trigger to flush pending batches.
      if (currentConfig.value.pruneOn === "agent-message") {
        await flushPending(ctx, "agent-message-text-turn");
      }
      return;
    }

    const batch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    if (batch.toolCalls.length === 0) return;

    pendingBatches.push(batch);
    logFlushDiagnostic(ctx, "queue-enqueue", "captured-tool-batch", "turn_end", {
      pendingGeneration,
      pendingCount: pendingBatches.length,
      turnIndex: batch.turnIndex,
      toolCallCount: batch.toolCalls.length,
      pruneOn: currentConfig.value.pruneOn,
    });

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, "every-turn");
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
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
      ctx.ui.setStatus(STATUS_WIDGET_ID, `prune: ${n} pending`);
      ctx.ui.notify(
        `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
        "info"
      );
    }
  });

  // ── tool_execution_end: flush when context_tag fires ─────────────────────
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, "context-tag");
  });

  // ── agent_end: safety net flush for agent-message mode ───────────────────
  // If the agent-message loop ends before a text-only trigger fires (e.g. aborted),
  // flush any remaining pending batches so they aren't lost. Agentic-auto mode
  // intentionally does not flush here; only the model's context_prune tool call
  // should trigger agentic-auto pruning.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (pendingBatches.length === 0) return;
    await flushPending(ctx, "agent-end-safety-net");
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;
    if (indexer.getIndex().size === 0) return undefined;

    const pruned = pruneMessages(event.messages, indexer);

    // Only return a modified list if something actually changed
    if (pruned.length === event.messages.length) return undefined;
    return { messages: pruned };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, flushPending);

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending, syncToolActivation, () => statsAccum.getStats(), indexer);
}
