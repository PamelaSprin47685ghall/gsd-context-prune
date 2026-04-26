export const PROACTIVE_COMPACT_USAGE_THRESHOLD = 2 / 3;

export interface ProactiveCompactUsage {
  tokens: number;
  contextWindow: number;
  ratio: number;
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function calculateUsageTokens(usage: unknown): number | undefined {
  const candidate = usage as Record<string, unknown> | undefined;
  if (!candidate) return undefined;

  const totalTokens = finitePositiveNumber(candidate.totalTokens);
  if (totalTokens) return totalTokens;

  const tokens = [candidate.input, candidate.output, candidate.cacheRead, candidate.cacheWrite]
    .map((value) => finitePositiveNumber(value) ?? 0)
    .reduce((total, value) => total + value, 0);

  return tokens > 0 ? tokens : undefined;
}

export function getProactiveCompactUsage(message: Record<string, any>, contextWindow: number): ProactiveCompactUsage | undefined {
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;

  const tokens = calculateUsageTokens(message.usage);
  if (!tokens || contextWindow <= 0) return undefined;

  return {
    tokens,
    contextWindow,
    ratio: tokens / contextWindow,
  };
}

export function shouldProactivelyCompact(usage: ProactiveCompactUsage | undefined): usage is ProactiveCompactUsage {
  return Boolean(usage && usage.ratio >= PROACTIVE_COMPACT_USAGE_THRESHOLD);
}
