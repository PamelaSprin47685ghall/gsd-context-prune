---
name: 023-official-compact-replaces-pruned-branches
description: Ensure official compact consumes the projected pruned history as replacement content, not stale monkey-patched raw branches.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect current compact hook behavior and related tests"
      - "- [x] step 2: verify Pi compact preparation shape from available code/docs"
  - phase: implementation
    steps:
      - "- [x] step 1: extract official compact projection into a reusable BranchRewriter method"
      - "- [x] step 2: update the session_before_compact hook to replace covered tool-call branches completely"
      - "- [x] step 3: add regression coverage for official compact branch replacement"
  - phase: validation
    steps:
      - "- [ ] step 1: run targeted tests"
      - "- [ ] step 2: run full project check"
---

# 023-official-compact-replaces-pruned-branches

## Phase 1 — Discovery
- [x] step 1: inspect current compact hook behavior and related tests
- [x] step 2: verify Pi compact preparation shape from available code/docs

## Phase 2 — Implementation
- [x] step 1: extract official compact projection into a reusable BranchRewriter method
- [x] step 2: update the session_before_compact hook to replace covered tool-call branches completely
- [x] step 3: add regression coverage for official compact branch replacement

## Phase 3 — Validation
- [x] step 1: run targeted tests
- [x] step 2: run full project check
