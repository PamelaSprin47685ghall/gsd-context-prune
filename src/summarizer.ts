import { complete } from "@gsd/pi-ai";
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig, SummarizeResult } from "./types.js";
import { serializeBatchForSummarizer, serializeBatchesForSummarizer } from "./batch-capture.js";

async function completeWithRetry(
  ctx: ExtensionContext,
  model: any,
  payload: any,
  options: any
): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await complete(model, payload, options);
    } catch (err: any) {
      attempt++;
      const isConcurrencyError = err.message?.includes("Concurrency limit exceeded");
      const delay = Math.min(Math.pow(2, attempt) * 1000, 30000);

      ctx.ui.notify(
        `pruner: summarization attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s...`,
        isConcurrencyError ? "info" : "warning"
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const SUMMARY_OMISSION_GUIDANCE = `Hot-context budget matters more than one-bullet-per-tool completeness.
Summarize durable signal only: facts, decisions, failures, file paths, commands, outputs, or constraints that future reasoning may need.
Omit low-value noise from the hot summary, such as successful no-op edits, directory listings with no finding, repeated status checks, or outputs fully superseded by later calls.
Do not invent facts for omitted calls. All original outputs remain recoverable with context_tree_query by toolCallId.`;

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For useful tool calls provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

${SUMMARY_OMISSION_GUIDANCE}

Keep useful tool calls to 1-3 bullet points. Be concise.`;

/** System prompt for batched summarization (multiple turns in one call). */
const BATCHED_SYSTEM_PROMPT = `You are summarizing multiple turns of tool calls made by an AI coding assistant.
For each turn, provide a concise summary of useful tool calls in that turn:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

${SUMMARY_OMISSION_GUIDANCE}

Keep useful tool calls to 1-3 bullet points. Group by turn. Be concise.`;

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  try {
    const model = resolveModel(config, ctx);
    if (!model) {
      ctx.ui.notify("pruner: summarization failed: no active model", "error");
      return null;
    }

    if (!ctx.modelRegistry.isProviderRequestReady(model.provider)) {
      ctx.ui.notify(`pruner: summarization failed: model ${model.provider}/${model.id} is not ready (missing API key or login)`, "error");
      return null;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    const headers = model.headers;

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    const response = await completeWithRetry(
      ctx,
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, headers }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const idList = toolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Pruned toolCallIds**: ${idList}\n` +
      `Some low-value tool outputs may be intentionally omitted from the hot summary. ` +
      `Use \`context_tree_query\` with any listed ID to retrieve the original full output.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches in a single LLM call.
 * Returns formatted markdown string, or null on failure.
 * On success, the footer lists ALL toolCallIds across all batches.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  if (batches.length === 0) return null;
  // Single batch — delegate to the single-batch path for a simpler prompt
  if (batches.length === 1) return summarizeBatch(batches[0], config, ctx);

  try {
    const model = resolveModel(config, ctx);
    if (!model) {
      ctx.ui.notify("pruner: batch summarization failed: no active model", "error");
      return null;
    }

    if (!ctx.modelRegistry.isProviderRequestReady(model.provider)) {
      ctx.ui.notify(`pruner: batch summarization failed: model ${model.provider}/${model.id} is not ready (missing API key or login)`, "error");
      return null;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    const headers = model.headers;

    const serialized = serializeBatchesForSummarizer(batches);
    const userMessage =
      BATCHED_SYSTEM_PROMPT + "\n\n<tool-call-batches>\n" + serialized + "\n</tool-call-batches>";

    const response = await completeWithRetry(
      ctx,
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, headers }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Collect ALL toolCallIds across all batches for recovery, including calls the summarizer omitted from the hot summary.
    const allToolCallIds = batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId));
    const idList = allToolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Pruned toolCallIds**: ${idList}\n` +
      `Some low-value tool outputs may be intentionally omitted from the hot summary. ` +
      `Use \`context_tree_query\` with any listed ID to retrieve the original full output.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: batch summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}
