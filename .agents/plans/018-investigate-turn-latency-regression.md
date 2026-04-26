---
name: 018-investigate-turn-latency-regression
description: Find and fix the last-commit regression that makes every turn response slow.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the last commit diff and changed execution paths"
      - "- [x] step 2: map turn-time handlers that can block every response"
  - phase: diagnosis
    steps:
      - "- [x] step 1: build a focused reproduction or benchmark for the suspected slow path"
      - "- [x] step 2: confirm the root cause with evidence"
  - phase: fix
    steps:
      - "- [x] step 1: apply the smallest safe change that removes the per-turn slowdown"
      - "- [x] step 2: update or add regression coverage"
  - phase: validation
    steps:
      - "- [x] step 1: run the focused regression test"
      - "- [x] step 2: run the project test suite or nearest verification command"
---

# 018-investigate-turn-latency-regression

## Phase 1 — Discovery
- [x] step 1: inspect the last commit diff and changed execution paths
- [x] step 2: map turn-time handlers that can block every response

## Phase 2 — Diagnosis
- [x] step 1: build a focused reproduction or benchmark for the suspected slow path
- [x] step 2: confirm the root cause with evidence

## Phase 3 — Fix
- [x] step 1: apply the smallest safe change that removes the per-turn slowdown
- [x] step 2: update or add regression coverage

## Phase 4 — Validation
- [x] step 1: run the focused regression test
- [x] step 2: run the project test suite or nearest verification command
