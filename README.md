# pi-context-prune

A [Pi coding-agent](https://github.com/badlogic/pi-mono) extension that **summarizes completed tool-call batches**, prunes raw tool outputs from future LLM context, and exposes a `context_tree_query` escape hatch to recover any original output on demand.

## Why

As long agent sessions grow, every tool call adds token-heavy output to the context window. Most of it is not needed verbatim after the first use. This extension:

1. **Detects** when an assistant turn finishes calling tools (`turn_end`)
2. **Summarizes** that batch of tool calls using your configured model
3. **Injects** a compact summary message before the next LLM call (`deliverAs: "steer"`)
4. **Prunes** the original verbose tool outputs from future context (`context` event)
5. **Preserves** every original output in the session index — retrievable at any time via `context_tree_query`

The session file is never modified. Pruning only affects the next request's context build.

## Usage

```bash
# Load from the repo root
pi -e /path/to/pi-context-prune

# Or from inside the repo
pi -e .
```

## Commands

| Command | Effect |
|---|---|
| `/context-prune on` | Enable pruning (and summarization) |
| `/context-prune off` | Disable pruning |
| `/context-prune status` | Show current mode and summarizer model |
| `/context-prune model` | Show current summarizer model |
| `/context-prune model anthropic/claude-haiku-3-5` | Set a specific summarizer model |

## Tool: `context_tree_query`

When pruning is on, the LLM sees compact summary messages instead of raw tool outputs. Each summary ends with:

```
Summarized toolCallIds: `abc12345`, `def67890`
Use `context_tree_query` with these IDs to retrieve the original full outputs.
```

The LLM can call `context_tree_query` with those IDs to get the full original output at any time, without those outputs permanently inflating context.

## Configuration

Config is stored in `.pi/settings.json` under the `contextPrune` key:

```json
{
  "contextPrune": {
    "enabled": false,
    "summarizerModel": "default"
  }
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | `true` / `false` | `false` |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` |

`"default"` means the current active Pi model. An explicit value like `"anthropic/claude-haiku-3-5"` uses that model for summarization (must be registered in Pi and have an API key).

## Architecture

```
index.ts               — entry point, wires events + modules
src/
  types.ts             — shared types and constants
  config.ts            — load/save .pi/settings.json contextPrune block
  batch-capture.ts     — serialize turn_end event → CapturedBatch
  summarizer.ts        — resolve model, call LLM, build summary text
  indexer.ts           — Map<toolCallId, ToolCallRecord> + session persistence
  pruner.ts            — filter context event messages
  query-tool.ts        — context_tree_query tool registration
  commands.ts          — /context-prune command + message renderer
```

### Event flow

```
turn_end (tool calls present + enabled)
  └─► captureBatch()        serialize the tool call batch
  └─► summarizeBatch()      call LLM → summary markdown text
  └─► indexer.addBatch()    persist to session via pi.appendEntry
  └─► pi.sendMessage()      inject summary (deliverAs: "steer")

context (enabled + index non-empty)
  └─► pruneMessages()       remove toolResult messages in the index

session_start
  └─► loadConfig()          read .pi/settings.json
  └─► indexer.reconstruct() rebuild Map from session branch entries
```

### Session persistence

- **Config** lives in `.pi/settings.json` → key `contextPrune`
- **Index** is persisted via `pi.appendEntry("context-prune-index", { toolCalls })` — one entry per summarized batch, NOT in LLM context
- **Summaries** are injected as `custom_message` entries with `customType: "context-prune-summary"` — these ARE in LLM context (replacing the raw outputs)
- The underlying session JSONL file always retains the original `ToolResultMessage` entries unchanged

## v1 Limitations

- Summarization only runs when pruning is **enabled**. If you enable it mid-session, earlier turns are not retroactively summarized.
- The `context_tree_query` tool is only active when the extension is loaded.
- The summarizer call happens synchronously inside `turn_end`, adding latency between turns proportional to the summarizer model's response time.
- The `/context-prune original-tree` browser (a dedicated TUI tree view of the raw session) is not implemented in v1. Use Pi's built-in `/tree` command to navigate session history.
- Summary grouping across multiple turns (e.g., "compress the last 5 summaries") is a follow-up item.

## Follow-up ideas

- Auto-summarize older unsummarized turns on `/context-prune on`
- Batch multiple turn summaries into a single meta-summary at compaction time
- `/context-prune original-tree` dedicated TUI browser
- Configurable pruning policy (prune only large tool results, prune by token count threshold)
- Tighter `/settings` integration once Pi exposes a settings UI API
