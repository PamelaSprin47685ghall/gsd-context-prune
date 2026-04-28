# gsd-context-prune

## What

**Prompt cache optimization** for pi/GSD. Strips dynamic content (CODEBASE) from the system prompt, replaces it with static HINTS + concise file listing. System prefix becomes byte-identical across turns → provider prefix cache hits.

## How

| Hook | Work |
|---|---|
| `before_agent_start` | Strips `[PROJECT CODEBASE — ...]` (injected by gsd-2), appends `[HINTS — Stable Guidance]` + `$ du -hxd1` listing |
| `before_provider_request` | Strips `prompt_cache_key` (gsd-2 sets it to random sessionId, preventing cross-session cache reuse) |
| `context` | Migrates `reasoning_content` → `thinking` blocks, projects summaries |
| `turn_end` | Auto-triggers global summary at 66% context usage |
| `session_start` | Recovers cross-session summaries from branch entries |

### System prompt layout

```
[pi framework prompt]
Current working directory: /path

[SYSTEM CONTEXT — GSD]
...
[KNOWLEDGE — ...]
[HINTS — Stable Guidance]       ← injected by context-prune
$ du -hxd1                       ← concise listing, replaces CODEBASE
   1.2M  src/
   4.0K  package.json
   456K  README.md
```

Everything above `$ du -hxd1` is fully static → prefix cache hits. The listing at the end changes only when files change, and is tiny compared to CODEBASE.

## Files

```
src/fs.js        — readFile, generateFileListing
src/inject.js    — loadHintSources, buildHintsBlock, buildStablePrompt
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
