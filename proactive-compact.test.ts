import { describe, expect, test } from "bun:test";
import {
  PROACTIVE_COMPACT_USAGE_THRESHOLD,
  calculateUsageTokens,
  getProactiveCompactUsage,
  shouldProactivelyCompact,
} from "./src/proactive-compact.ts";

describe("proactive compact threshold", () => {
  test("uses provider total tokens when available", () => {
    expect(calculateUsageTokens({ totalTokens: 120, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(120);
  });

  test("falls back to usage components", () => {
    expect(calculateUsageTokens({ input: 40, output: 10, cacheRead: 20, cacheWrite: 30 })).toBe(100);
  });

  test("triggers at two thirds projected context usage", () => {
    const usage = getProactiveCompactUsage(
      { role: "assistant", stopReason: "stop", usage: { totalTokens: 200 } },
      300,
    );

    expect(PROACTIVE_COMPACT_USAGE_THRESHOLD).toBe(2 / 3);
    expect(shouldProactivelyCompact(usage)).toBe(true);
  });

  test("uses session context usage when trailing tool results push the turn over threshold", () => {
    const usage = getProactiveCompactUsage(
      { role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } },
      300,
      { tokens: 215, contextWindow: 300, percent: 71.5 },
    );

    expect(usage).toEqual({ tokens: 215, contextWindow: 300, ratio: 215 / 300 });
    expect(shouldProactivelyCompact(usage)).toBe(true);
  });

  test("falls back to assistant usage when session context usage is unavailable after compact", () => {
    const usage = getProactiveCompactUsage(
      { role: "assistant", stopReason: "stop", usage: { totalTokens: 200 } },
      300,
      { tokens: null, contextWindow: 300, percent: null },
    );

    expect(shouldProactivelyCompact(usage)).toBe(true);
  });

  test("does not trigger below threshold or on invalid assistant responses", () => {
    expect(shouldProactivelyCompact(getProactiveCompactUsage(
      { role: "assistant", stopReason: "stop", usage: { totalTokens: 199 } },
      300,
    ))).toBe(false);
    expect(getProactiveCompactUsage(
      { role: "assistant", stopReason: "error", usage: { totalTokens: 300 } },
      300,
    )).toBeUndefined();
    expect(getProactiveCompactUsage(
      { role: "assistant", stopReason: "error", usage: { totalTokens: 300 } },
      300,
      { tokens: 300, contextWindow: 300 },
    )).toBeUndefined();
    expect(getProactiveCompactUsage(
      { role: "user", usage: { totalTokens: 300 } },
      300,
      { tokens: 300, contextWindow: 300 },
    )).toBeUndefined();
  });
});
