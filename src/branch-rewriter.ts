import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { RewriteEntryData, RewriteResetEntryData, SummaryMessageDetails } from "./types.js";
import { CUSTOM_TYPE_REWRITE, CUSTOM_TYPE_REWRITE_RESET, CUSTOM_TYPE_SUMMARY } from "./types.js";

type AgentMessage = Record<string, any>;

type ToolCallBlock = Record<string, any>;

interface RewriteRecord extends RewriteEntryData {
  id: string;
}

function rewriteId(record: RewriteEntryData): string {
  return `${record.turnIndex}:${record.timestamp}:${record.toolCallIds.join(",")}`;
}

function toSummaryMessage(record: RewriteRecord): AgentMessage {
  return {
    role: "custom",
    customType: CUSTOM_TYPE_SUMMARY,
    content: record.summaryText,
    display: true,
    details: {
      toolCallIds: record.toolCallIds,
      toolNames: record.toolNames,
      turnIndex: record.turnIndex,
      timestamp: record.timestamp,
      sidecar: true,
      historyReplaced: true,
    } satisfies SummaryMessageDetails,
    timestamp: record.completedAt,
  };
}

function isRewriteEntry(entry: any): boolean {
  return entry?.type === "custom" && entry.customType === CUSTOM_TYPE_REWRITE;
}

function isRewriteResetEntry(entry: any): boolean {
  return entry?.type === "custom" && entry.customType === CUSTOM_TYPE_REWRITE_RESET;
}

function isRewriteData(data: unknown): data is RewriteEntryData {
  const candidate = data as Partial<RewriteEntryData> | undefined;
  return Boolean(
    candidate &&
    typeof candidate.summaryText === "string" &&
    Array.isArray(candidate.toolCallIds) &&
    Array.isArray(candidate.toolNames) &&
    typeof candidate.turnIndex === "number" &&
    typeof candidate.timestamp === "number" &&
    typeof candidate.completedAt === "number",
  );
}

function getToolCallBlockId(block: ToolCallBlock): string | undefined {
  if (typeof block.id === "string") return block.id;
  if (typeof block.toolCallId === "string") return block.toolCallId;
  return undefined;
}

function isRewriteResetData(data: unknown): data is RewriteResetEntryData {
  const candidate = data as Partial<RewriteResetEntryData> | undefined;
  return Boolean(
    candidate &&
    typeof candidate.resetAt === "number" &&
    typeof candidate.reason === "string",
  );
}

export class BranchRewriter {
  private records: RewriteRecord[] = [];
  private replacementByToolCallId = new Map<string, RewriteRecord>();

  reconstructFromSession(ctx: ExtensionContext): void {
    this.clearInMemory();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (isRewriteResetEntry(entry) && isRewriteResetData((entry as any).data)) {
        this.clearInMemory();
        continue;
      }
      if (!isRewriteEntry(entry) || !isRewriteData((entry as any).data)) continue;
      this.upsert((entry as any).data);
    }
  }

  addReplacement(data: RewriteEntryData, pi: ExtensionAPI): void {
    this.upsert(data);
    pi.appendEntry(CUSTOM_TYPE_REWRITE, data);
  }

  resetAfterCompact(pi: ExtensionAPI, reason: string): void {
    this.clearInMemory();
    pi.appendEntry(CUSTOM_TYPE_REWRITE_RESET, {
      resetAt: Date.now(),
      reason,
    } satisfies RewriteResetEntryData);
  }

  project(messages: AgentMessage[]): AgentMessage[] {
    if (this.records.length === 0) return messages;

    const insertedReplacementIds = new Set<string>();
    const projected: AgentMessage[] = [];

    for (const message of messages) {
      if (message?.role !== "toolResult") {
        projected.push(message);
        continue;
      }

      const replacement = this.replacementByToolCallId.get(message.toolCallId);
      if (!replacement) {
        projected.push(message);
        continue;
      }

      if (!insertedReplacementIds.has(replacement.id)) {
        projected.push(toSummaryMessage(replacement));
        insertedReplacementIds.add(replacement.id);
      }
    }

    return projected;
  }

  projectForCompaction(messages: AgentMessage[]): AgentMessage[] {
    if (this.records.length === 0) return messages;

    const projected: AgentMessage[] = [];

    for (const message of messages) {
      if (message?.role === "toolResult") {
        if (this.replacementByToolCallId.has(message.toolCallId)) continue;
        projected.push(message);
        continue;
      }

      if (message?.role === "assistant" && Array.isArray(message.content)) {
        const remainingContent = message.content.filter((block: ToolCallBlock) => {
          if (block?.type !== "toolCall") return true;
          return !this.replacementByToolCallId.has(getToolCallBlockId(block) ?? "");
        });

        if (remainingContent.length > 0) projected.push({ ...message, content: remainingContent });
        continue;
      }

      projected.push(message);
    }

    return projected;
  }

  hasReplacementInMessage(message: AgentMessage | undefined): boolean {
    if (!message) return false;
    if (message.role === "toolResult") {
      return this.replacementByToolCallId.has(message.toolCallId);
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((block) => {
      if (block?.type !== "toolCall") return false;
      return this.replacementByToolCallId.has(getToolCallBlockId(block) ?? "");
    });
  }

  getReplacementCount(): number {
    return this.records.length;
  }

  getReplacementForToolCallId(toolCallId: string): RewriteRecord | undefined {
    return this.replacementByToolCallId.get(toolCallId);
  }

  toSummaryMessage(record: RewriteRecord): AgentMessage {
    return toSummaryMessage(record);
  }

  private clearInMemory(): void {
    this.records = [];
    this.replacementByToolCallId.clear();
  }

  private upsert(data: RewriteEntryData): void {
    const record = { ...data, id: rewriteId(data) };
    const existingIndex = this.records.findIndex((existing) => existing.id === record.id);
    if (existingIndex >= 0) {
      for (const toolCallId of this.records[existingIndex].toolCallIds) {
        this.replacementByToolCallId.delete(toolCallId);
      }
      this.records[existingIndex] = record;
    } else {
      this.records.push(record);
    }

    for (const toolCallId of record.toolCallIds) {
      this.replacementByToolCallId.set(toolCallId, record);
    }
  }
}
