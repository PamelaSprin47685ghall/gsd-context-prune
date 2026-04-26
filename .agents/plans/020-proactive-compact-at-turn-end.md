---
name: 020-proactive-compact-at-turn-end
description: Trigger official compaction from turn_end when provider-reported projected context usage reaches two thirds.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: confirm turn_end carries assistant usage and compact is available on extension context"
      - "- [x] step 2: define safe gating so compact happens once per threshold crossing"
  - phase: implementation
    steps:
      - "- [x] step 1: add projected usage calculation helper for assistant messages"
      - "- [x] step 2: trigger ctx.compact from turn_end at two-thirds usage"
      - "- [x] step 3: integrate proactive compact with existing session_compact reset flow"
  - phase: validation
    steps:
      - "- [x] step 1: add regression coverage for threshold and turn_end wiring"
      - "- [x] step 2: run project verification"
---

# 020-proactive-compact-at-turn-end

## Phase 1 — Discovery
- [x] step 1: confirm turn_end carries assistant usage and compact is available on extension context
- [x] step 2: define safe gating so compact happens once per threshold crossing

## Phase 2 — Implementation
- [x] step 1: add projected usage calculation helper for assistant messages
- [x] step 2: trigger ctx.compact from turn_end at two-thirds usage
- [x] step 3: integrate proactive compact with existing session_compact reset flow

## Phase 3 — Validation
- [x] step 1: add regression coverage for threshold and turn_end wiring
- [x] step 2: run project verification
