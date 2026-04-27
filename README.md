# gsd-context-prune

**Context pruning, HINTS injection, and payload stabilization — one zero-dependency extension for pi/GSD.**

---

## What it solves

| Problem | How |
|---|---|
| **Context overflow** in long agent sessions — `toolResult` messages pile up and push early instructions out | Two-layer compression: on-demand primary (tool call summarization via sidecar LLM) and automatic global collapse at 66% context usage |
| **Prompt cache degradation** — dynamic content in system prompt (timestamps, CODEBASE maps) causes prefix cache misses on every turn | Strips CODEBASE from system prompt → fully static. Injects real-time file listing into the last user message via append-only semantics. Never mutates prior messages |

---

## How it works

### Dialogue structure (one-shot, no hacks)

```
system(static) → user(dynamic context) → ai(acknowledges) → user(real prompt) → ...
```

No `before_agent_start` hooks, no custom-message patching, no consecutive-user-message detection. Messages flow naturally.

### Two-layer context pruning

**Primary pruning** — on-demand, triggered when the model calls `context_prune`. The extension collects pending `toolResult` batches, sends them to a sidecar LLM for condensation, then replaces the raw results with a phantom summary on subsequent turns. The model keeps calling `context_prune` after meaningful batches — the extension does the rest.

**Global summary (worldline collapse)** — automatic, triggered at every `turn_end` when context usage exceeds 2/3. The entire projected conversation is sent to the sidecar LLM which extracts "context + current progress." The result replaces all prior messages. The main agent never notices.

### HINTS injection

At `before_provider_request`, loads `~/.gsd/HINTS.md` (or `${GSD_HOME}/HINTS.md`) and `.gsd/HINTS.md` (fallback to root `HINTS.md`). Builds a formatted `[HINTS — Stable Guidance]` block and prepends it to the system prompt. Already-present blocks are skipped — idempotent.

### Payload stabilization

At `before_provider_request`:

- **Strip CODEBASE** from system prompt — removes the GSD-injected `[PROJECT CODEBASE — ...]` section. What remains is fully static → prefix cache hits.
- **Inject file listing** — runs a live `du -hxd1` equivalent on the project directory (right-aligned sizes, trailing `/` for directories, recursive totals). Appended to the last user message inside `<system-notification>` tags. Only the last user message carries the listing — earlier messages are never touched (append-only semantics).
- **Normalize messages** — `content: null` → `""`, missing `reasoning_content` on assistant messages → `""` (for reasoning_effort mode).
- **Stabilize OpenAI Responses API IDs** — strips `msg_*`, `fc_*`, `call_*` IDs from function call metadata so the payload structure is deterministic across retries.

### Append-only semantics (cache maximization)

```
Turn 1:  sys → user("hello" + notif_1)
Turn 2:  sys → user("hello" + notif_1) → ai → user("more" + notif_2)
Turn 3:  sys → user("hello" + notif_1) → ai → user("more" + notif_2) → ai → user("again" + notif_3)
```

- System prompt is identical every turn → prefix cache hit
- All messages before the current last user message are frozen → cache hit
- Only the final user message changes (new listing) — unavoidable

---

## Hooks & lifecycle

| Hook | What it does |
|---|---|
| `session_start` | Recovers cross-session summaries from branch entries. Notifies user of loaded state |
| `context` | Projects summaries onto messages (phantom replacement). Injects file listing |
| `turn_end` | Collects tool calls from the just-finished turn. Checks context usage — triggers global collapse if > 2/3 |
| `before_provider_request` | Strips CODEBASE, injects HINTS, normalizes messages, stabilizes IDs |

---

## Commands

```
/pruner provider/model-id
```

Changes the sidecar summarizer model. Defaults to the same model as the main agent. Persisted in `~/.gsd/context-prune.json`.

```
/pruner
```

Shows current sidecar model.

---

## Tests

```bash
node --test test/*.test.mjs
```

15 tests covering plugin registration, hints loading, CODEBASE stripping, file listing injection, message normalization, ID stabilization, payload stabilization, hook integration, and summary projection.

---

## License

MIT
