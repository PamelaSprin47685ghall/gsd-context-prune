---
name: 015-context-prune-omit-low-value-tools
description: Let the summarizer omit low-value tool outputs from the hot summary while preserving all pruned outputs for recovery.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect context_prune tool schema and flushPending flow"
      - "- [x] step 2: inspect summarizer footer/index behavior for recoverability constraints"
  - phase: implementation
    steps:
      - "- [x] step 1: keep context_prune zero-argument so the main agent does not choose discard IDs"
      - "- [x] step 2: update summarizer instructions to omit low-value noise from the hot summary"
      - "- [x] step 3: update footers and docs to list all pruned IDs as recoverable, including omitted details"
  - phase: validation
    steps:
      - "- [x] step 1: add source-level regression tests for KISS omission support"
      - "- [x] step 2: run tests/checks and review the focused diff"
---

# 015-context-prune-omit-low-value-tools

## Phase 1 — Discovery
- [x] step 1: inspect context_prune tool schema and flushPending flow
- [x] step 2: inspect summarizer footer/index behavior for recoverability constraints

## Phase 2 — Implementation
- [x] step 1: keep context_prune zero-argument so the main agent does not choose discard IDs
- [x] step 2: update summarizer instructions to omit low-value noise from the hot summary
- [x] step 3: update footers and docs to list all pruned IDs as recoverable, including omitted details

## Phase 3 — Validation
- [x] step 1: add source-level regression tests for KISS omission support
- [x] step 2: run tests/checks and review the focused diff
