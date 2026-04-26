import { describe, expect, test } from "bun:test";
import { BranchRewriter } from "./src/branch-rewriter.ts";
import { CUSTOM_TYPE_REWRITE, CUSTOM_TYPE_SUMMARY, type RewriteEntryData } from "./src/types.ts";

const replacement: RewriteEntryData = {
  summaryText: "Summarized useful tool output.",
  toolCallIds: ["call-1", "call-2"],
  toolNames: ["read", "bash"],
  turnIndex: 3,
  timestamp: 1000,
  completedAt: 2000,
};

function messages() {
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1" }, { type: "toolCall", id: "call-2" }] },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "raw 1" }] },
    { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "raw 2" }] },
    { role: "toolResult", toolCallId: "call-3", content: [{ type: "text", text: "raw 3" }] },
  ];
}

describe("BranchRewriter", () => {
  test("projects one summary message where the first replaced tool result appeared", () => {
    const rewriter = new BranchRewriter();
    rewriter.addReplacement(replacement, { appendEntry() {} } as any);

    const projected = rewriter.project(messages());

    expect(projected).toHaveLength(4);
    expect(projected[0].role).toBe("user");
    expect(projected[1].role).toBe("assistant");
    expect(projected[2]).toMatchObject({
      role: "custom",
      customType: CUSTOM_TYPE_SUMMARY,
      content: replacement.summaryText,
      display: true,
      timestamp: replacement.completedAt,
      details: {
        toolCallIds: replacement.toolCallIds,
        toolNames: replacement.toolNames,
        turnIndex: replacement.turnIndex,
        timestamp: replacement.timestamp,
        sidecar: true,
        historyReplaced: true,
      },
    });
    expect(projected[3]).toMatchObject({ role: "toolResult", toolCallId: "call-3" });
  });

  test("persists replacement metadata and reconstructs it from session entries", () => {
    const appended: Array<{ customType: string; data: RewriteEntryData }> = [];
    const first = new BranchRewriter();
    first.addReplacement(replacement, {
      appendEntry(customType: string, data: RewriteEntryData) {
        appended.push({ customType, data });
      },
    } as any);

    expect(appended).toEqual([{ customType: CUSTOM_TYPE_REWRITE, data: replacement }]);

    const second = new BranchRewriter();
    second.reconstructFromSession({
      sessionManager: {
        getBranch() {
          return [
            { type: "custom", customType: "other", data: replacement },
            { type: "custom", customType: CUSTOM_TYPE_REWRITE, data: { summaryText: "invalid" } },
            { type: "custom", customType: CUSTOM_TYPE_REWRITE, data: replacement },
          ];
        },
      },
    } as any);

    expect(second.getReplacementCount()).toBe(1);
    expect(second.project(messages())[2]).toMatchObject({
      role: "custom",
      customType: CUSTOM_TYPE_SUMMARY,
      content: replacement.summaryText,
    });
  });

  test("looks up replacements by tool call id", () => {
    const rewriter = new BranchRewriter();
    rewriter.addReplacement(replacement, { appendEntry() {} } as any);

    expect(rewriter.getReplacementForToolCallId("call-1")).toMatchObject({
      summaryText: replacement.summaryText,
      toolCallIds: replacement.toolCallIds,
    });
    expect(rewriter.getReplacementForToolCallId("missing-call")).toBeUndefined();
  });

  test("upserts duplicate replacement IDs instead of emitting duplicate summaries", () => {
    const rewriter = new BranchRewriter();
    rewriter.addReplacement({ ...replacement, summaryText: "first" }, { appendEntry() {} } as any);
    rewriter.addReplacement({ ...replacement, summaryText: "second" }, { appendEntry() {} } as any);

    const summaries = rewriter.project(messages()).filter((message) => message.role === "custom");

    expect(rewriter.getReplacementCount()).toBe(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toBe("second");
  });
});
