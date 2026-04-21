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
    ├── types.ts               # Shared types, constants, and interfaces
    ├── config.ts              # Load/save .pi/settings.json contextPrune block
    ├── batch-capture.ts       # Serialize turn_end events into CapturedBatch objects
    ├── summarizer.ts          # LLM call that summarizes a CapturedBatch to markdown
    ├── indexer.ts             # Runtime Map<toolCallId, ToolCallRecord> + session persistence
    ├── pruner.ts              # Filter context event messages (removes summarized ToolResultMessages)
    ├── query-tool.ts          # Register the context_tree_query tool
    └── commands.ts            # Register /pruner command + settings overlay + summary message renderer
```

### `index.ts` — Extension entry point
Wires all modules together and registers Pi event handlers:
- **`pendingBatches: CapturedBatch[]`** — queue of captured batches not yet summarized; drained by `flushPending`.
- **`flushPending(ctx)`** — summarizes + indexes all pending batches and injects steer messages; called immediately on `every-turn`, or deferred to `tool_execution_end` / `/pruner now`.
- **`session_start`** — loads config from `~/.pi/agent/context-prune/settings.json`, rebuilds the in-memory index, clears `pendingBatches`, and updates the footer status widget.
- **`session_tree`** — rebuilds the index and clears `pendingBatches` after branch navigation (pending batches belong to the old branch).
- **`turn_end`** — captures the batch, pushes to `pendingBatches`; flushes immediately in `every-turn` mode, otherwise notifies user of queue depth and what will trigger the flush.
- **`tool_execution_end`** — when `event.toolName === "context_tag"` and mode is `on-context-tag`, calls `flushPending`.
- **`context`** — filters the message array sent to the LLM, removing `ToolResultMessage` entries that have been summarized (replaced by summary messages).

### `src/types.ts` — Shared types and constants
Single source of truth for all interfaces and constants:
- **`CapturedBatch`** / **`CapturedToolCall`** — snapshot of one assistant turn's tool calls + results.
- **`ToolCallRecord`** — full record stored in the runtime index (includes original `resultText`).
- **`IndexEntryData`** — data shape written to session via `pi.appendEntry` for persistence across restarts.
- **`PruneOn`** — `"every-turn" | "on-context-tag" | "on-demand"` — when summarization is triggered.
- **`ContextPruneConfig`** — `{ enabled, summarizerModel, pruneOn }` stored in `~/.pi/agent/context-prune/settings.json`.
- **`SummaryMessageDetails`** — metadata attached to `context-prune-summary` custom messages.
- Constants: `CUSTOM_TYPE_SUMMARY`, `CUSTOM_TYPE_INDEX`, `STATUS_WIDGET_ID`, `DEFAULT_CONFIG`.

### `src/config.ts` — Config persistence
- **`SETTINGS_PATH`** — constant resolving to `~/.pi/agent/context-prune/settings.json` (global, project-independent).
- **`loadConfig()`** — reads `SETTINGS_PATH`, parses JSON, merges with `DEFAULT_CONFIG`. Returns defaults on any read/parse error.
- **`saveConfig(config)`** — creates the directory if needed (`mkdir recursive`) then writes the full config as the file root (no key wrapping).

### `src/batch-capture.ts` — Turn capture and serialization
- **`captureBatch(message, toolResults, turnIndex, timestamp)`** — converts raw `turn_end` event data into a typed `CapturedBatch`. Matches each `toolCall` content block in the `AssistantMessage` with its corresponding `ToolResultMessage` by `toolCallId`.
- **`serializeBatchForSummarizer(batch)`** — renders a `CapturedBatch` as plain text for the summarizer LLM. Truncates individual result text at 2 000 chars to keep the summarizer prompt manageable.

### `src/summarizer.ts` — LLM summarization
- **`resolveModel(config, ctx)`** — resolves `config.summarizerModel` to a model instance. `"default"` returns `ctx.model`; `"provider/model-id"` looks up via `ctx.modelRegistry.find()` with a fallback + warning.
- **`summarizeBatch(batch, config, ctx)`** — calls `@mariozechner/pi-ai`'s `complete()` with a fixed system prompt asking for concise per-tool-call bullet points. Appends a footer listing all summarized `toolCallId`s and instructions to use `context_tree_query` for recovery. Returns `null` (and notifies the user) on failure.

### `src/indexer.ts` — `ToolCallIndexer` class
Maintains the runtime `Map<toolCallId, ToolCallRecord>` and handles session persistence:
- **`reconstructFromSession(ctx)`** — scans the current branch's session entries for `CUSTOM_TYPE_INDEX` custom entries and repopulates the in-memory map.
- **`addBatch(batch, pi)`** — adds all records from a batch to the map and calls `pi.appendEntry(CUSTOM_TYPE_INDEX, ...)` to persist them so they survive restarts and branch switches.
- **`isSummarized(toolCallId)`** — used by the pruner to decide which messages to drop.
- **`getRecord(toolCallId)`** / **`lookupToolCalls(ids)`** — used by the query tool to retrieve full original outputs.

### `src/pruner.ts` — Context message filter
- **`pruneMessages(messages, indexer)`** — filters the `context` event's message array. Drops any message with `role === "toolResult"` whose `toolCallId` is present in the index. All other messages (including `AssistantMessage` tool-call blocks that carry the IDs) are kept so the model can still reference them when calling `context_tree_query`.

### `src/query-tool.ts` — `context_tree_query` tool
Registers a Pi tool that allows the LLM (or user) to recover pruned outputs:
- Accepts `{ toolCallIds: string[] }`.
- Looks up each ID in the indexer; returns full `resultText` (truncated via Pi's `truncateHead` helper) along with tool name, args, status, and turn index.
- IDs not found in the index return a "(not found)" notice rather than an error.

### `src/commands.ts` — `/pruner` command + settings overlay + renderer
- **`pruneStatusText(config)`** — formats the footer widget string including mode: e.g. `prune: ON (on tag)`.
- **`PRUNE_ON_MODES`** — `{ value, label }` array for the `prune-on` interactive selector.
- **`SUBCOMMANDS`** — `{ value, label }` array shared by `getArgumentCompletions` and `ctx.ui.select()`.
- **`HELP_TEXT`** — full explanation of what pruner does and all subcommands with usage.
- **`getArgumentCompletions(prefix)`** — filters `SUBCOMMANDS` by prefix for tab-completion as the user types.
- **Bare `/pruner`** (no args) — calls `ctx.ui.select()` to show an interactive picker over `SUBCOMMANDS`.
- **`/pruner settings`** — opens an interactive `SettingsList` overlay for toggling enabled/disabled, selecting prune-on mode, and picking a summarizer model. The model picker uses a `submenu` (nested `SettingsList` with `enableSearch`) for browsing/searching available models. Changes are saved immediately.
- **`/pruner on|off`** — enables/disables pruning, saves config, updates footer widget.
- **`/pruner status`** — shows enabled state, summarizer model, and prune trigger.
- **`/pruner model [value]`** — gets or sets the summarizer model (e.g. `anthropic/claude-haiku-3-5`).
- **`/pruner prune-on [value]`** — gets or sets the trigger mode; bare form shows `ctx.ui.select()` picker over `PRUNE_ON_MODES`.
- **`/pruner now`** — calls `flushPending(ctx)` immediately; guards against pruning being disabled.
- **`/pruner help`** — displays `HELP_TEXT` via `ctx.ui.notify`.
- **`default` case** — directs unknown subcommands to run `/pruner help`.
- **Message renderer** for `context-prune-summary` — renders summary messages in the TUI with a styled header showing turn index and tool count; collapses to one line when not expanded.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Pruning only `ToolResultMessage`s | `AssistantMessage` tool-call blocks (which carry IDs) are kept so the model can call `context_tree_query` by ID |
| Steer delivery for summary messages | Ensures the summary lands in context *before* the next LLM call, not after |
| `pi.appendEntry` for persistence | Session custom entries survive restarts and branch navigation; index is rebuilt on `session_start` / `session_tree` |
| `summarizerModel: "default"` | Reuses the active model's credentials — no hidden side-channel or extra config needed |
| Config in `~/.pi/agent/context-prune/settings.json` | Extension owns its own file — no risk of clobbering other Pi settings, and config persists across all projects |
| `pruneOn` trigger modes | Three modes let the user trade immediacy for batch efficiency — `on-context-tag` aligns summarization with the model's own save-point rhythm |
| `pendingBatches` queue + `flushPending` | Decouples capture (always at `turn_end`) from summarization (mode-dependent), keeping the two concerns separate |
