import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("./src/commands.ts", import.meta.url), "utf8");
const contextPruneToolSource = readFileSync(new URL("./src/context-prune-tool.ts", import.meta.url), "utf8");

test("serializes flush execution and invalidates stale queue generations across session boundaries", () => {
  assert.match(indexSource, /let pendingGeneration = 0/);
  assert.match(indexSource, /let flushInFlight: Promise<void> \| null = null/);
  assert.match(indexSource, /if \(flushInFlight\)/);
  assert.match(indexSource, /await flushInFlight/);
  assert.match(indexSource, /if \(drainGeneration !== pendingGeneration\)/);

  assert.match(indexSource, /resetPendingBatches\("session-start"\)/);
  assert.match(indexSource, /resetPendingBatches\("session-tree"\)/);
});

test("emits structured queue\/flush diagnostics with plugin\/phase\/cause\/scenarioId vocabulary", () => {
  assert.match(indexSource, /plugin=\$\{PLUGIN_NAME\} phase=\$\{phase\} cause=\$\{cause\} scenarioId=\$\{scenarioId\}/);
  assert.match(indexSource, /logFlushDiagnostic\("flush-start", "pending-batches-drained"/);
  assert.match(indexSource, /logFlushDiagnostic\("flush-end", "summary-indexed"/);
  assert.match(indexSource, /batchCount/);
  assert.match(indexSource, /toolCallCount/);
});

test("awaits flush completion for manual and agentic tool triggers", () => {
  assert.match(commandsSource, /flushPending:\s*\(ctx: ExtensionCommandContext, scenarioId\?: string\) => Promise<void>/);
  assert.match(commandsSource, /await flushPending\(ctx, "manual-now"\)/);
  assert.match(contextPruneToolSource, /await flushPending\(ctx, "agentic-auto-tool"\)/);
});
