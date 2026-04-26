---
name: 022-fix-proactive-compact-missing-after-reset
description: Ensure proactive compaction triggers at two-thirds usage even after rewrite state has been cleared by a prior compact.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: identify gates that can suppress proactive compact above threshold"
      - "- [x] step 2: confirm behavior after session_compact resets rewrite state"
  - phase: implementation
    steps:
      - "- [x] step 1: remove replacement-count requirement from proactive compact trigger"
      - "- [x] step 2: keep diagnostics reporting replacement count without using it as a gate"
  - phase: validation
    steps:
      - "- [x] step 1: add regression coverage for trigger wiring without replacement gate"
      - "- [x] step 2: run project verification"
---

# 022-fix-proactive-compact-missing-after-reset

## Phase 1 — Discovery
- [x] step 1: identify gates that can suppress proactive compact above threshold
- [x] step 2: confirm behavior after session_compact resets rewrite state

## Phase 2 — Implementation
- [x] step 1: remove replacement-count requirement from proactive compact trigger
- [x] step 2: keep diagnostics reporting replacement count without using it as a gate

## Phase 3 — Validation
- [x] step 1: add regression coverage for trigger wiring without replacement gate
- [x] step 2: run project verification
