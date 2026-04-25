# Project Guidance

This repository is for a Pi coding-agent extension that prunes tool-call trees before the next request is sent.

## Working style
- Keep changes small, focused, and reversible.
- Read existing files before editing them.
- Preserve user work; do not overwrite unrelated changes.
- Prefer Markdown for plans and notes, and keep code and docs aligned.

## Planning
- Use the `planning` skill for any multi-step task.
- Store plans in `.agents/plans/`.
- Use zero-padded numbered plan filenames like `000-first-plan.md`, `001-another-plan.md`, and `002-plan-more.md`.
- Keep plan checklists in sync with actual progress.

## Implementation
- When adding code, include a brief explanation of why the change exists.
- Add tests or a reproducible verification command for behavior changes when possible.

---

## Code Structure

```
pi-context-prune/
├── index.ts                   # Extension entry point — wires all modules together
├── package.json               # Pi package manifest; declares extension at ./index.ts
└── src/
    ├── types.ts               # Shared types, constants, and interfaces (including PruneOn modes)
    ├── config.ts              # Load/save ~/.pi/agent/context-prune/settings.json
    ├── batch-capture.ts       # Serialize turn_end events into CapturedBatch objects
    ├── summarizer.ts          # LLM call that summarizes a CapturedBatch to markdown
    ├── indexer.ts             # Runtime Map<toolCallId, ToolCallRecord> + session persistence
    ├── branch-rewriter.ts     # Sidecar rewrite metadata + projected session branch
    ├── query-tool.ts          # Register the context_tree_query tool for recovering pruned outputs
    ├── stats.ts               # StatsAccumulator for cumulative summarizer token/cost tracking
    └── commands.ts            # /pruner command + interactive settings overlay + summary message renderer
```

### `index.ts` — Extension entry point
Wires all modules together and registers Pi event handlers:
- **`pendingBatches: CapturedBatch[]`** — queue of captured batches not yet summarized; drained by `flushPending`.
- **`flushPending(ctx)`** — schedules sidecar summarization and returns without blocking the main agent path. The sidecar drains pending batches, summarizes them in a single LLM call, persists raw-output indexes and rewrite metadata, updates stats, and notifies the UI when projected history has been replaced. If another trigger arrives while a sidecar is running, it marks a follow-up drain so newly queued batches are summarized after the current sidecar completes.
- **`session_start`** — loads config from `~/.pi/agent/context-prune/settings.json`, rebuilds the in-memory index, branch rewriter, and stats accumulator, clears `pendingBatches`, updates the footer status widget, and notifies the user of the loaded state.
- **`session_tree`** — rebuilds the index, branch rewriter, and stats after branch navigation (pending batches and stats belong to the current branch).
- **`turn_end`** — captures the batch, pushes to `pendingBatches`. Behavior depends on `pruneOn` mode:
  - `every-turn`: schedules sidecar summarization immediately.
  - `agent-message`: if the turn has **no** tool results (i.e., a final text-only response), schedules sidecar summarization; otherwise queues.
  - `on-context-tag` / `on-demand`: queues and notifies the user of pending count and trigger.
- **`tool_execution_end`** — when `event.toolName === "context_tag"` and mode is `on-context-tag`, schedules sidecar summarization.
- **`agent_end`** — safety-net scheduling for `agent-message` mode only: if the agent loop ends before a text-only turn fires (e.g. aborted), schedules summarization for remaining pending batches so they aren't lost. `agentic-auto` intentionally does not flush on `agent_end`; only a model `context_prune` tool call triggers that mode automatically.
- **`context`** — applies the `BranchRewriter` projection. Future LLM calls see one summary message at the first removed tool-result position and no raw `ToolResultMessage`s covered by completed rewrite metadata.

### `src/types.ts` — Shared types and constants
Single source of truth for all interfaces and constants:
- **`CapturedBatch`** / **`CapturedToolCall`** — snapshot of one assistant turn's tool calls + results. `CapturedBatch` also carries `assistantText` (any non-tool-call text from the assistant message).
- **`ToolCallRecord`** — full record stored in the runtime index (includes original `resultText`).
- **`IndexEntryData`** — data shape written to session via `pi.appendEntry` for persistence across restarts.
- **`PruneOn`** — `"every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto"` — when summarization is triggered:
  - `every-turn`: summarize after every tool-calling turn.
  - `on-context-tag`: batch turns, flush when `context_tag` is called.
  - `on-demand`: only when the user runs `/pruner now`.
  - `agent-message`: batch turns, flush when the agent sends a final text-only response (or when the agent loop ends).
  - `agentic-auto`: the LLM decides when to prune by calling the `context_prune` tool; no `agent_end` safety-net flush.
- **`PRUNE_ON_MODES`** — `{ value, label }` array for interactive selectors.
- **`ContextPruneConfig`** — `{ enabled, summarizerModel, pruneOn }` stored in `~/.pi/agent/context-prune/settings.json`.
- **`SummarizerStats`** — cumulative token/cost stats: `{ totalInputTokens, totalOutputTokens, totalCost, callCount }`. Persisted via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`SummarizeResult`** — return type from summarizer: `{ summaryText, usage }` carrying both the markdown summary and LLM usage data.
- **`SummaryMessageDetails`** — metadata attached to projected `context-prune-summary` custom messages.
- **`RewriteEntryData`** — metadata persisted via `CUSTOM_TYPE_REWRITE`; reconstructs sidecar branch projections across session reloads.
- Constants: `CUSTOM_TYPE_SUMMARY`, `CUSTOM_TYPE_INDEX`, `CUSTOM_TYPE_STATS`, `CUSTOM_TYPE_REWRITE`, `STATUS_WIDGET_ID`, `DEFAULT_CONFIG`, `CONTEXT_PRUNE_TOOL_NAME`, `AGENTIC_AUTO_SYSTEM_PROMPT`.

### `src/config.ts` — Config persistence
- **`SETTINGS_PATH`** — constant resolving to `~/.pi/agent/context-prune/settings.json` (global, project-independent).
- **`loadConfig()`** — reads `SETTINGS_PATH`, parses JSON, merges with `DEFAULT_CONFIG`. Returns defaults on any read/parse error.
- **`saveConfig(config)`** — creates the directory if needed (`mkdir recursive`) then writes the full config as the file root (no key wrapping).

### `src/batch-capture.ts` — Turn capture and serialization
- **`captureBatch(message, toolResults, turnIndex, timestamp)`** — converts raw `turn_end` event data into a typed `CapturedBatch`. Extracts `assistantText` from `TextContent` blocks and matches each `ToolCall` content block in the `AssistantMessage` with its corresponding `ToolResultMessage` by `toolCallId`. Falls back to `"(no result)"` if no match is found for a tool call.
- **`serializeBatchForSummarizer(batch)`** — renders a single `CapturedBatch` as plain text for the summarizer LLM. Includes `assistantText` as a header if present. Truncates individual result text at 2 000 chars to keep the summarizer prompt manageable.
- **`serializeBatchesForSummarizer(batches)`** — renders multiple `CapturedBatch` objects into a single text block for batched summarization. Each batch is rendered as a `=== Turn N ===` section, separated by blank lines. Reuses `serializeBatchForSummarizer` for each batch's body.

### `src/summarizer.ts` — LLM summarization
- **`resolveModel(config, ctx)`** — resolves `config.summarizerModel` to a model instance. `"default"` returns `ctx.model`; `"provider/model-id"` splits on `/` and looks up via `ctx.modelRegistry.find(provider, modelId)` with a fallback to `ctx.model` + warning on failure.
- **`summarizeBatch(batch, config, ctx)`** — summarizes a single `CapturedBatch` in one LLM call. The summarizer keeps durable signal and may omit low-value noise from the hot summary while the footer lists all pruned IDs. Returns `SummarizeResult` (summary text + usage) on success, `null` on failure.
- **`summarizeBatches(batches, config, ctx)`** — summarizes multiple `CapturedBatch` objects in a **single LLM call**. If only one batch, delegates to `summarizeBatch`. All pending tool outputs are sent to the summarizer; low-value details may be omitted from the generated hot summary, but every original output remains indexed. Returns `SummarizeResult` on success, `null` on failure.

### `src/indexer.ts` — `ToolCallIndexer` class
Maintains the runtime `Map<toolCallId, ToolCallRecord>` and handles session persistence:
- **`reconstructFromSession(ctx)`** — scans the current branch's session entries for `CUSTOM_TYPE_INDEX` custom entries and repopulates the in-memory map.
- **`addBatch(batch, pi)`** — adds all records from a batch to the map and calls `pi.appendEntry(CUSTOM_TYPE_INDEX, ...)` to persist them so they survive restarts and branch switches.
- **`isSummarized(toolCallId)`** — returns whether a raw output has been indexed.
- **`getRecord(toolCallId)`** / **`lookupToolCalls(ids)`** — used by the query tool to retrieve full original outputs.

### `src/branch-rewriter.ts` — `BranchRewriter` class
Maintains sidecar rewrite metadata and projects future LLM context:
- **`reconstructFromSession(ctx)`** — scans the current branch for `CUSTOM_TYPE_REWRITE` entries and rebuilds replacement records.
- **`addReplacement(data, pi)`** — upserts the in-memory replacement and persists append-only rewrite metadata.
- **`project(messages)`** — replaces covered `ToolResultMessage`s with one projected `context-prune-summary` custom message at the first removed result position. Assistant tool-call blocks are kept so IDs remain addressable.

### `src/query-tool.ts` — `context_tree_query` tool
Registers a Pi tool that allows the LLM (or user) to recover pruned outputs:
- Accepts `{ toolCallIds: string[] }`.
- Looks up each ID in the indexer; returns full `resultText` (truncated via Pi's `truncateHead` helper with `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`) along with tool name, args, status, and turn index.
- IDs not found in the index return a "(not found)" notice rather than an error.
- Returns `{ content, details: { results } }` with found records in the `details` field.

### `src/stats.ts` — `StatsAccumulator` class + formatting helpers
Accumulates cumulative token/cost stats for summarizer LLM calls and persists them to the session:
- **`add(usage)`** — accumulates one LLM call's usage (input tokens, output tokens, total cost).
- **`getStats()`** — returns a `SummarizerStats` snapshot.
- **`reset()`** — clears all accumulated stats to zero.
- **`reconstructFromSession(ctx)`** — scans session entries for `CUSTOM_TYPE_STATS` and restores the last snapshot.
- **`persist(pi)`** — writes current stats as a session entry via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`formatTokens(n)`** — formats token counts like Pi's footer (e.g. `1.2k`, `340`).
- **`formatCost(n)`** — formats cost like `$0.003` or `<$0.001`.
- **`statsSuffix(stats)`** — builds the status widget suffix string (e.g. ` │ ↑1.2k ↓340 $0.003`) or `""` if no calls yet.

### `src/commands.ts` — `/pruner` command + settings overlay + renderer
- **`SettingsOverlay`** — a TUI `Container` subclass that wraps a `SettingsList` with a `DynamicBorder` + title. Forwards `handleInput` and `invalidate` to the inner list so keyboard navigation works inside the overlay.
- **`pruneStatusText(config, stats?)`** — formats the footer widget string including mode label and optional stats suffix: e.g. `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003`.
- **`SUBCOMMANDS`** — `{ value, label }` array for tab-completion and the interactive picker.
- **`HELP_TEXT`** — full explanation of all subcommands, including `agent-message` and `agentic-auto` modes.
- **`getArgumentCompletions(prefix)`** — filters `SUBCOMMANDS` by prefix for tab-completion.
- **Bare `/pruner`** (no args) — calls `ctx.ui.select()` to show an interactive picker over `SUBCOMMANDS`.
- **`/pruner settings`** — opens an interactive `SettingsOverlay` (via `ctx.ui.custom()` with `overlay: true`) containing a `SettingsList` with three items:
  1. **Enabled** — toggle between `true` / `false`
  2. **Prune trigger** — cycle through all five `PruneOn` modes
  3. **Summarizer model** — shows current value; pressing Enter opens a searchable submenu listing `"default"` plus all models from `ctx.modelRegistry.getAvailable()`. Selecting a model saves immediately.
  All changes are persisted to `settings.json` on every toggle and the footer widget is updated.
- **`/pruner on|off`** — enables/disables pruning, saves config, updates footer widget.
- **`/pruner status`** — shows enabled state, summarizer model, prune trigger, and cumulative summarizer stats (calls, tokens, cost).
- **`/pruner stats`** — shows detailed cumulative summarizer token/cost stats.
- **`/pruner model [value]`** — gets or sets the summarizer model (e.g. `anthropic/claude-haiku-3-5`).
- **`/pruner prune-on [value]`** — gets or sets the trigger mode; bare form shows `ctx.ui.select()` picker over `PRUNE_ON_MODES`.
- **`/pruner now`** — schedules sidecar summarization for pending tool calls; guards against pruning being disabled.
- **`/pruner help`** — displays `HELP_TEXT` via `ctx.ui.notify`.
- **`default` case** — directs unknown subcommands to run `/pruner help`.
- **Message renderer** for `context-prune-summary` — renders summary messages in the TUI with a styled header (accent color) showing turn index and tool count; collapses to header-only when not expanded, shows full content when expanded.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Sidecar rewrite projection | Summarization runs outside the main agent path; the extension owns a rewritten branch projection instead of mutating Pi's append-only session file |
| Pruning only `ToolResultMessage`s | `AssistantMessage` tool-call blocks (which carry IDs) are kept so the model can call `context_tree_query` by ID |
| `pi.appendEntry` for persistence | Session custom entries survive restarts and branch navigation; index is rebuilt on `session_start` / `session_tree` |
| `summarizerModel: "default"` | Reuses the active model's credentials via `ctx.modelRegistry.getApiKeyAndHeaders()` — no hidden side-channel or extra config needed |
| Config in `~/.pi/agent/context-prune/settings.json` | Extension owns its own file — no risk of clobbering other Pi settings, and config persists across all projects |
| Five `pruneOn` trigger modes | `every-turn` (immediate), `on-context-tag` (aligned with save-points), `on-demand` (manual), `agent-message` (batch until final text response), `agentic-auto` (LLM decides via `context_prune` tool) — lets users trade immediacy for batch efficiency |
| `pendingBatches` queue + `flushPending` | Decouples capture (always at `turn_end`) from summarization (mode-dependent). `flushPending` schedules sidecar summarization so normal agent latency is not blocked by summarizer latency. |
| `agent_end` safety-net flush | Prevents orphaned pending batches if the agent loop terminates before a text-only turn fires in `agent-message` mode |
| `SettingsOverlay` wrapper | Required because `Container` alone doesn't forward keyboard input — the wrapper delegates `handleInput`/`invalidate` to the inner `SettingsList` |
| `context` handler returns `undefined` when no pruning occurs | Avoids unnecessary message-list reconstruction when nothing was filtered |
| Stats persistence via `CUSTOM_TYPE_STATS` | Stats are snapshots persisted alongside index entries; on `session_start` / `session_tree`, the last snapshot is applied, matching the same lifecycle as the indexer |
| `SummarizeResult` return type | Summarizer functions return `{ summaryText, usage }` so callers can accumulate token/cost data without side effects in the summarizer module |
| Status widget includes stats suffix | Footer shows `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` after summarizer calls, giving users visibility into pruner overhead |
| Auth via `ctx.modelRegistry.getApiKeyAndHeaders()` | Explicit credential resolution for the summarizer LLM call, with error notification on failure |
