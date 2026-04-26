import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { RewriteEntryData, SummaryMessageDetails } from "./types.js";
import { CUSTOM_TYPE_REWRITE, CUSTOM_TYPE_SUMMARY } from "./types.js";

type AgentMessage = Record<string, any>;

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

export class BranchRewriter {
  private records: RewriteRecord[] = [];

  reconstructFromSession(ctx: ExtensionContext): void {
    this.records = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (!isRewriteEntry(entry) || !isRewriteData((entry as any).data)) continue;
      this.upsert((entry as any).data);
    }
  }

  addReplacement(data: RewriteEntryData, pi: ExtensionAPI): void {
    this.upsert(data);
    pi.appendEntry(CUSTOM_TYPE_REWRITE, data);
  }

  project(messages: AgentMessage[]): AgentMessage[] {
    if (this.records.length === 0) return messages;

    const replacementByToolCallId = new Map<string, RewriteRecord>();
    for (const record of this.records) {
      for (const toolCallId of record.toolCallIds) {
        replacementByToolCallId.set(toolCallId, record);
      }
    }

    const insertedReplacementIds = new Set<string>();
    const projected: AgentMessage[] = [];

    for (const message of messages) {
      if (message?.role !== "toolResult") {
        projected.push(message);
        continue;
      }

      const replacement = replacementByToolCallId.get(message.toolCallId);
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

  getReplacementCount(): number {
    return this.records.length;
  }

  getReplacementForToolCallId(toolCallId: string): RewriteRecord | undefined {
    return this.records.find((r) => r.toolCallIds.includes(toolCallId));
  }

  toSummaryMessage(record: RewriteRecord): AgentMessage {
    return toSummaryMessage(record);
  }

  private upsert(data: RewriteEntryData): void {
    const record = { ...data, id: rewriteId(data) };
    const existingIndex = this.records.findIndex((existing) => existing.id === record.id);
    if (existingIndex >= 0) {
      this.records[existingIndex] = record;
      return;
    }
    this.records.push(record);
  }
}
