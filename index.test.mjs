import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./src/types.ts", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("./src/commands.ts", import.meta.url), "utf8");
const contextPruneToolSource = readFileSync(new URL("./src/context-prune-tool.ts", import.meta.url), "utf8");

test("serializes flush execution and invalidates stale queue generations across session boundaries", () => {
  assert.match(indexSource, /let pendingGeneration = 0/);
  assert.match(indexSource, /let flushInFlight: Promise<void> \| null = null/);
  assert.match(indexSource, /if \(flushInFlight\)/);
  assert.match(indexSource, /await flushInFlight/);
  assert.match(indexSource, /if \(drainGeneration !== pendingGeneration\)/);

  assert.match(indexSource, /resetPendingBatches\(ctx, "session-start"\)/);
  assert.match(indexSource, /resetPendingBatches\(ctx, "session-tree"\)/);
});

test("emits structured queue/flush diagnostics and safely guards missing ui.notify", () => {
  assert.match(indexSource, /const PLUGIN_NAME = "gsd-context-prune"/);
  assert.match(indexSource, /plugin=\$\{PLUGIN_NAME\} phase=\$\{phase\} cause=\$\{cause\} scenarioId=\$\{scenarioId\}/);
  assert.match(indexSource, /const notify = \(ctx as \{ ui\?: \{ notify\?: unknown \} \} \| undefined\)\?\.ui\?\.notify/);
  assert.match(indexSource, /if \(typeof notify === "function"\)/);

  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-await", "existing-flush-in-flight"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-skip", "no-pending-batches"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-start", "pending-batches-drained"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-end", "discarded-stale-generation"/);
  assert.match(indexSource, /logFlushDiagnostic\(ctx, "flush-end", "summary-indexed"/);
});

test("defaults to agentic-auto prune mode", () => {
  assert.match(typesSource, /export const DEFAULT_CONFIG: ContextPruneConfig = \{[\s\S]*pruneOn: "agentic-auto"/);
  assert.match(indexSource, /import \{ STATUS_WIDGET_ID, CONTEXT_PRUNE_TOOL_NAME, AGENTIC_AUTO_SYSTEM_PROMPT, DEFAULT_CONFIG \}/);
  assert.match(indexSource, /value: \{ \.\.\.DEFAULT_CONFIG \}/);
});

test("agent_end safety net only flushes agent-message mode, not agentic-auto", () => {
  assert.match(indexSource, /agent_end: safety net flush for agent-message mode/);
  assert.match(indexSource, /if \(currentConfig\.value\.pruneOn !== "agent-message"\) return/);
  assert.doesNotMatch(indexSource, /pruneOn !== "agent-message" && currentConfig\.value\.pruneOn !== "agentic-auto"/);
});

test("awaits flush completion for manual and agentic tool triggers", () => {
  assert.match(commandsSource, /flushPending:\s*\(ctx: ExtensionCommandContext, scenarioId\?: string\) => Promise<void>/);
  assert.match(commandsSource, /await flushPending\(ctx, "manual-now"\)/);
  assert.match(contextPruneToolSource, /await flushPending\(ctx, "agentic-auto-tool"\)/);
});
