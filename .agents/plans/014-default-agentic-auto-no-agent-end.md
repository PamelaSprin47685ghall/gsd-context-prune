---
name: 014-default-agentic-auto-no-agent-end
description: Change the default prune trigger to agentic-auto and prevent agentic-auto from flushing on agent_end.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect default config and agent_end trigger code"
      - "- [x] step 2: find docs and tests that describe default/trigger behavior"
  - phase: implementation
    steps:
      - "- [x] step 1: update runtime defaults to agentic-auto"
      - "- [x] step 2: restrict agent_end safety net to agent-message only"
      - "- [x] step 3: update tests and documentation for the new default and trigger semantics"
  - phase: validation
    steps:
      - "- [x] step 1: run the test suite/check commands"
      - "- [x] step 2: write the quick-task summary and commit the focused changes"
---

# 014-default-agentic-auto-no-agent-end

## Phase 1 — Discovery
- [x] step 1: inspect default config and agent_end trigger code
- [x] step 2: find docs and tests that describe default/trigger behavior

## Phase 2 — Implementation
- [x] step 1: update runtime defaults to agentic-auto
- [x] step 2: restrict agent_end safety net to agent-message only
- [x] step 3: update tests and documentation for the new default and trigger semantics

## Phase 3 — Validation
- [x] step 1: run the test suite/check commands
- [x] step 2: write the quick-task summary and commit the focused changes
