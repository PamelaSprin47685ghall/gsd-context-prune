import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./src/types.ts", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("./src/commands.ts", import.meta.url), "utf8");
const contextPruneToolSource = readFileSync(new URL("./src/context-prune-tool.ts", import.meta.url), "utf8");
const summarizerSource = readFileSync(new URL("./src/summarizer.ts", import.meta.url), "utf8");
const treeBrowserSource = readFileSync(new URL("./src/tree-browser.ts", import.meta.url), "utf8");

test("schedules sidecar flushes and invalidates stale queue generations across session boundaries", () => {
  assert.match(indexSource, /let pendingGeneration = 0/);
  assert.match(indexSource, /let flushInFlight: Promise<void> \| null = null/);
  assert.match(indexSource, /let flushRequestedWhileRunning = false/);
  assert.match(indexSource, /sidecar-already-running/);
  assert.match(indexSource, /void flushPending\(ctx, `\$\{scenarioId\}-queued`\)/);
  assert.doesNotMatch(indexSource, /await flushInFlight/);
  assert.match(indexSource, /if \(drainGeneration !== pendingGeneration\)/);

  assert.match(indexSource, /resetPendingBatches\(ctx, "session-start"\)/);
  assert.match(indexSource, /resetPendingBatches\(ctx, "session-tree"\)/);
  assert.match(indexSource, /resetPendingBatches\(ctx, "session-switch"\)/);
  assert.match(indexSource, /resetPendingBatches\(ctx, "session-fork"\)/);
});

test("emits structured sidecar diagnostics and safely guards missing ui.notify", () => {
  assert.match(indexSource, /const PLUGIN_NAME = "gsd-context-prune"/);
  assert.match(indexSource, /plugin=\$\{PLUGIN_NAME\} phase=\$\{phase\} cause=\$\{cause\} scenarioId=\$\{scenarioId\}/);
  assert.match(indexSource, /const notify = \(ctx as \{ ui\?: \{ notify\?: unknown \} \} \| undefined\)\?\.ui\?\.notify/);
  assert.match(indexSource, /if \(typeof notify === "function"\)/);

  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-skip", "sidecar-already-running"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-skip", "no-pending-batches"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-start", "sidecar-batches-drained"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-end", "discarded-stale-generation"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-end", "sidecar-history-replaced"/);
});

test("defaults to agentic-auto prune mode", () => {
  assert.match(typesSource, /export const DEFAULT_CONFIG: ContextPruneConfig = \{[\s\S]*pruneOn: "agentic-auto"/);
  assert.match(indexSource, /import \{[^}]*STATUS_WIDGET_ID[^}]*CONTEXT_PRUNE_TOOL_NAME[^}]*AGENTIC_AUTO_SYSTEM_PROMPT[^}]*DEFAULT_CONFIG[^}]*\}/);
  assert.match(indexSource, /value: \{ \.\.\.DEFAULT_CONFIG \}/);
});

test("agent_end safety net only schedules agent-message mode, not agentic-auto", () => {
  assert.match(indexSource, /if \(currentConfig\.value\.pruneOn !== "agent-message"\) return/);
  assert.match(indexSource, /void flushPending\(ctx, "agent-end-safety-net"\)/);
  assert.doesNotMatch(indexSource, /pruneOn !== "agent-message" && currentConfig\.value\.pruneOn !== "agentic-auto"/);
});

test("summarizer may omit low-value details without making the main agent choose IDs", () => {
  assert.match(contextPruneToolSource, /parameters: Type\.Object\(\{\}\)/);
  assert.doesNotMatch(contextPruneToolSource, /discardToolCallIds|discardReason/);
  assert.doesNotMatch(typesSource, /PruneSummaryOptions|discardToolCallIds|discardReason/);
  assert.match(summarizerSource, /Omit low-value noise from the hot summary/);
  assert.match(summarizerSource, /Pruned toolCallIds/);
  assert.match(summarizerSource, /including calls the summarizer omitted from the hot summary/);
});

test("context_prune and manual commands schedule sidecar work instead of reporting synchronous completion", () => {
  assert.match(commandsSource, /flushPending:\s*\(ctx: ExtensionCommandContext, scenarioId\?: string\) => Promise<void>/);
  assert.match(commandsSource, /await flushPending\(ctx, "manual-now"\)/);
  assert.match(contextPruneToolSource, /await flushPending\(ctx, "agentic-auto-tool"\)/);
  assert.match(contextPruneToolSource, /Context prune sidecar scheduled/);
  assert.doesNotMatch(contextPruneToolSource, /Context prune completed/);
});

test("branch rewriter is the only context projection path", () => {
  assert.match(typesSource, /export const CUSTOM_TYPE_REWRITE = "context-prune-rewrite"/);
  assert.match(typesSource, /export const CUSTOM_TYPE_REWRITE_RESET = "context-prune-rewrite-reset"/);
  assert.match(typesSource, /export interface RewriteEntryData/);
  assert.match(typesSource, /export interface RewriteResetEntryData/);
  assert.match(indexSource, /branchRewriter\.addReplacement\(replacement, pi\)/);
  assert.match(indexSource, /return \{ messages: branchRewriter\.project\(event\.messages\) \}/);
  assert.match(indexSource, /pi\.on\("session_compact"/);
  assert.match(indexSource, /branchRewriter\.resetAfterCompact\(pi/);
  assert.doesNotMatch(indexSource, /pruneMessages|deliverAs: "steer"/);
});

test("official compact consumes the full pruned branch instead of keeping monkey-patched raw entries", () => {
  assert.match(indexSource, /projectOfficialCompactPreparation/);
  assert.match(indexSource, /branchRewriter\.projectForCompaction/);
  assert.match(indexSource, /branchRewriter\.hasReplacementInMessage/);
  assert.match(indexSource, /lastCoveredIndex >= firstKeptIndex/);
  assert.match(indexSource, /preparation\.firstKeptEntryId = branchEntries\[lastCoveredIndex \+ 1\]\?\.id/);
  assert.match(indexSource, /context-prune-after:/);
});

test("proactive compact triggers from turn_end at projected two-thirds usage without requiring sidecar replacements", () => {
  assert.match(indexSource, /getProactiveCompactUsage/);
  assert.match(indexSource, /shouldProactivelyCompact/);
  assert.match(indexSource, /let proactiveCompactInFlight = false/);
  assert.match(indexSource, /const currentContextUsage = ctx\.getContextUsage\?\.\(\)/);
  assert.match(indexSource, /getProactiveCompactUsage\(event\.message, contextWindow\(ctx\), currentContextUsage\)/);
  assert.match(indexSource, /pendingCompactResetReason = "proactive-threshold"/);
  assert.match(indexSource, /await maybeProactiveCompact\(event, ctx\)/);
  assert.match(indexSource, /ctx\.compact\(\{/);
  assert.match(indexSource, /projected-context-threshold/);
  assert.doesNotMatch(indexSource, /const maybeProactiveCompact[\s\S]*branchRewriter\.getReplacementCount\(\) === 0\) return[\s\S]*const shouldResumeInterruptedToolTurn/);
});

test("proactive compact resumes interrupted tool turns with a visible custom message", () => {
  assert.match(typesSource, /export const CUSTOM_TYPE_PROACTIVE_RESUME = "context-prune-proactive-resume"/);
  assert.match(indexSource, /shouldResumeInterruptedToolTurn = Boolean\(event\.toolResults && event\.toolResults\.length > 0\)/);
  assert.match(indexSource, /customType: CUSTOM_TYPE_PROACTIVE_RESUME/);
  assert.match(indexSource, /display: true/);
  assert.match(indexSource, /triggerTurn: true/);
  assert.match(indexSource, /compact-resume/);
});

test("tree browser reads sidecar rewrite entries as pruned summaries", () => {
  assert.match(treeBrowserSource, /CUSTOM_TYPE_REWRITE/);
  assert.match(treeBrowserSource, /customEntry\.customType !== CUSTOM_TYPE_REWRITE/);
  assert.match(treeBrowserSource, /summaryText = typeof data\?\.summaryText === "string"/);
});
