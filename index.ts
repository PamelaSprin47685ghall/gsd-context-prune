/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save .pi/settings.json contextPrune block
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /context-prune command + message renderer
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
import type { ContextPruneConfig } from "./src/types.js";
import { STATUS_WIDGET_ID } from "./src/types.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /context-prune commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { enabled: false, summarizerModel: "default" },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // ── session_start: restore config + index ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from .pi/settings.json
    currentConfig.value = await loadConfig(ctx.cwd);

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Update footer status
    ctx.ui.setStatus(STATUS_WIDGET_ID, currentConfig.value.enabled ? "prune: ON" : "prune: OFF");

    ctx.ui.notify(
      `context-prune loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
  });

  // ── turn_end: detect tool-calling turns, summarize, inject ────────────────
  pi.on("turn_end", async (event, ctx) => {
    // Only process turns that actually called tools
    if (!event.toolResults || event.toolResults.length === 0) return;

    // Only run when pruning is enabled (v1 policy: summarize iff enabled)
    if (!currentConfig.value.enabled) return;

    // Capture the batch from this turn
    const batch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );

    if (batch.toolCalls.length === 0) return;

    // Notify user that summarization is in progress
    ctx.ui.setStatus(STATUS_WIDGET_ID, "prune: summarizing…");

    // Call the summarizer LLM
    const summaryText = await summarizeBatch(batch, currentConfig.value, ctx);

    // Restore status
    ctx.ui.setStatus(STATUS_WIDGET_ID, "prune: ON");

    if (!summaryText) return; // summarization failed; errors already notified

    // Persist the full tool outputs to the index (for context_tree_query recovery)
    indexer.addBatch(batch, pi);

    // Inject summary as a custom message with steer delivery
    // so it lands in context before the next LLM call
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

  // ── Register /context-prune command + summary message renderer ────────────
  registerCommands(pi, currentConfig);
}
