---
name: 017-sidecar-cleanup-tighten
description: Remove legacy pruning leftovers and tighten sidecar branch rewrite tests/docs.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: scan sidecar rewrite code, legacy pruner references, and tests"
  - phase: implementation
    steps:
      - "- [x] step 1: remove obsolete pruner module and stale references"
      - "- [x] step 2: tighten branch rewriter implementation names and API surface"
      - "- [x] step 3: replace source-string assertions with direct behavior tests where practical"
  - phase: validation
    steps:
      - "- [x] step 1: run tests and build after cleanup"
---

# 017-sidecar-cleanup-tighten

## Phase 1 — Discovery
- [x] step 1: scan sidecar rewrite code, legacy pruner references, and tests

## Phase 2 — Implementation
- [x] step 1: remove obsolete pruner module and stale references
- [x] step 2: tighten branch rewriter implementation names and API surface
- [x] step 3: replace source-string assertions with direct behavior tests where practical

## Phase 3 — Validation
- [x] step 1: run tests and build after cleanup
