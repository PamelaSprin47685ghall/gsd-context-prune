# gsd-context-prune

## What

**Sidecar summarization engine** for pi/GSD. Auto-compresses tool call outputs into summaries, projects them into the message stream, and triggers global collapse at high context usage. Session-aware — summaries persist across branches.

## How

| Hook | Work |
|---|---|
| `session_start` / `session_switch` / `session_fork` / `session_tree` | Restores summaries from branch entries |
| `context` | Migrates `reasoning_content` → `thinking` blocks, projects cached summaries into message stream, patches model info onto orphaned assistant messages |
| `turn_end` | Collects tool calls for future summarization; auto-triggers global summary at 66% context usage |
| `input` | Auto-triggers primary (tool-call output) summary before each new turn, compressing prior tool results |

## Files

```
src/settings.js  — model ID persistence
src/summary.js   — summary engine (primary + global collapse)
```

## Commands

```
/pruner              — show summarizer model
/pruner <model-id>   — change summarizer model (persisted)
```

## License

MIT
MIT
