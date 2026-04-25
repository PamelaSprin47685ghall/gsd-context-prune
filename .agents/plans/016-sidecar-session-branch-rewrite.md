---
name: 016-sidecar-session-branch-rewrite
description: Move context pruning summarization out of the main agent path by maintaining a rewritten session branch projection in the extension.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect current flush, context pruning, persistence, and command/tool triggers"
      - "- [x] step 2: confirm Pi message shapes needed for a projected rewritten branch"
  - phase: implementation
    steps:
      - "- [x] step 1: add a branch rewriter that records summary replacements and projects messages atomically"
      - "- [x] step 2: change flush triggers to schedule sidecar summarization without blocking normal turns"
      - "- [x] step 3: persist summary replacement metadata and restore it on session start/tree navigation"
      - "- [x] step 4: update UI notifications, status text, and context_prune tool output for async behavior"
  - phase: validation
    steps:
      - "- [x] step 1: update tests for sidecar scheduling and rewritten branch projection"
      - "- [x] step 2: run the repository verification command"
---

# 016-sidecar-session-branch-rewrite

## Phase 1 — Discovery
- [x] step 1: inspect current flush, context pruning, persistence, and command/tool triggers
- [x] step 2: confirm Pi message shapes needed for a projected rewritten branch

## Phase 2 — Implementation
- [x] step 1: add a branch rewriter that records summary replacements and projects messages atomically
- [x] step 2: change flush triggers to schedule sidecar summarization without blocking normal turns
- [x] step 3: persist summary replacement metadata and restore it on session start/tree navigation
- [x] step 4: update UI notifications, status text, and context_prune tool output for async behavior

## Phase 3 — Validation
- [x] step 1: update tests for sidecar scheduling and rewritten branch projection
- [x] step 2: run the repository verification command
