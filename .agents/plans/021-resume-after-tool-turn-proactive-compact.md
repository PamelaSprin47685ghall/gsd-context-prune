---
name: 021-resume-after-tool-turn-proactive-compact
description: Resume the LLM with an explicit visible pruner message after proactive compaction interrupts a tool-result turn.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: confirm compact aborts active agent operation and custom messages can trigger a visible turn"
      - "- [x] step 2: define resume behavior only for tool-result turn interruption"
  - phase: implementation
    steps:
      - "- [x] step 1: add visible proactive-resume custom message type"
      - "- [x] step 2: send visible triggerTurn resume message only after tool-turn proactive compact completes"
  - phase: validation
    steps:
      - "- [x] step 1: update regression coverage for explicit resume wiring"
      - "- [x] step 2: run project verification"
---

# 021-resume-after-tool-turn-proactive-compact

## Phase 1 — Discovery
- [x] step 1: confirm compact aborts active agent operation and custom messages can trigger a visible turn
- [x] step 2: define resume behavior only for tool-result turn interruption

## Phase 2 — Implementation
- [x] step 1: add visible proactive-resume custom message type
- [x] step 2: send visible triggerTurn resume message only after tool-turn proactive compact completes

## Phase 3 — Validation
- [x] step 1: update regression coverage for explicit resume wiring
- [x] step 2: run project verification
