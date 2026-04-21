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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch } from "./src/batch-capture.js";
import { summarizeBatch } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands } from "./src/commands.js";
import type { ContextPruneConfig, CapturedBatch } from "./src/types.js";
import { STATUS_WIDGET_ID } from "./src/types.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { enabled: false, summarizerModel: "default", pruneOn: "every-turn" },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];

  // Summarizes + indexes all pending batches and injects steer messages.
  // Called immediately in "every-turn" mode, deferred otherwise.
  const flushPending = async (ctx: any) => {
    if (pendingBatches.length === 0) return;
    const batches = pendingBatches.splice(0); // drain atomically

    ctx.ui.setStatus(STATUS_WIDGET_ID, "prune: summarizing…");

    for (const batch of batches) {
      const summaryText = await summarizeBatch(batch, currentConfig.value, ctx);
      if (!summaryText) continue; // failure already notified by summarizeBatch

      indexer.addBatch(batch, pi);

      pi.sendMessage(
        {
          customType: "context-prune-summary",
          content: summaryText,
          display: true,
          details: {
            toolCallIds: batch.toolCalls.map((tc) => tc.toolCallId),
            toolNames: batch.toolCalls.map((tc) => tc.toolName),
            turnIndex: batch.turnIndex,
            timestamp: batch.timestamp,
          },
        },
        { deliverAs: "steer" }
      );
    }

    ctx.ui.setStatus(
      STATUS_WIDGET_ID,
      currentConfig.value.enabled ? "prune: ON" : "prune: OFF"
    );
  };

  // ── session_start: restore config + index ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from ~/.pi/agent/context-prune/settings.json
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    ctx.ui.setStatus(STATUS_WIDGET_ID, currentConfig.value.enabled ? "prune: ON" : "prune: OFF");

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!event.toolResults || event.toolResults.length === 0) return;
    if (!currentConfig.value.enabled) return;

    const batch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    if (batch.toolCalls.length === 0) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx);
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      const trigger =
        currentConfig.value.pruneOn === "on-context-tag"
          ? "next context_tag"
          : "/pruner now";
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
    await flushPending(ctx);
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

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending);
}
