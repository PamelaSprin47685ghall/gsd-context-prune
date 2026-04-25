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

test("awaits flush completion for manual and agentic tool triggers", () => {
  assert.match(commandsSource, /flushPending:\s*\(ctx: ExtensionCommandContext, scenarioId\?: string\) => Promise<void>/);
  assert.match(commandsSource, /await flushPending\(ctx, "manual-now"\)/);
  assert.match(contextPruneToolSource, /await flushPending\(ctx, "agentic-auto-tool"\)/);
});
