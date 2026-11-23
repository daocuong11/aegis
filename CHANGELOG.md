# Changelog

All notable changes to Project AEGIS are recorded here. Versions follow
the phase structure of the project: a phase that lands is a minor version.

## 0.2.0 — Phase 3: the Chief (2026-11-24)

### Added
- **Chief orchestrator** (`aegis/chief.js`): decomposes a mission (goal +
  granted scopes + work items) into a task graph with explicit
  dependencies (`needs`) and data flow (`inputFrom`), dispatches subtasks
  in topological order through the Phase 2 Orchestrator, and produces a
  final report.
- **Specialist cards** (`aegis/cards/*.json`, loaded by `aegis/cards.js`):
  one data file per specialist declaring its role, capabilities (action
  allowlist), allowed tools and scope boundary. At startup the chief
  verifies every card against the orchestrator manifest and the agent
  registry — a card that widens the manifest's tool allowlist is refused
  (`CARD_EXCEEDS_MANIFEST`).
- **Scope enforcement in code, twice**: at decomposition and again at
  dispatch. An out-of-scope subtask refuses the mission with
  `OUT_OF_SCOPE`; an action outside the card's capabilities refuses with
  `ACTION_NOT_ALLOWED`. Refusals are written to the audit log
  (`chief.decompose_refused`).
- **Verification pass** (`Chief.verify`): a mission is `DONE` only when
  every subtask is accounted for, succeeded, carries evidence and a
  non-null output, and stayed inside the granted scopes. Otherwise the
  report is `NEEDS_REVIEW`. Failed dependencies cause dependents to be
  SKIPPED rather than run on partial inputs.
- **Summariser specialist** (`summariser` role): deterministic digest of
  labelled sections; sixth registered specialist, with its own card and
  manifest declaration.
- **Audit events** for the whole chief lifecycle: `chief.mission_start`,
  `chief.decomposed`, `chief.dispatch`, `chief.result`, `chief.skipped`,
  `chief.dispatch_refused`, `chief.verified` /
  `chief.verification_failed`, `chief.mission_done`.
- **Demo** (`examples/chief-demo.js`, `npm run demo:chief`): the sample
  mission — classify a finding, review a patch, check the workspace,
  digest the results — plus the refusal path with a scope grant removed.
- 21 new tests (`test/chief.test.js`): card loading/validation,
  decomposition, dependency ordering, cycle and unknown-dependency
  refusal, scope and action enforcement, audit logging, failure
  propagation, and the demo mission path. Full suite: 315 tests.

### Notes
- Decomposition is deterministic and rule-based; there is no LLM call in
  the chief layer. Specialists remain the existing deterministic,
  offline handlers.

## 0.1.0 — Phases 0–2

- Task lifecycle and state machine, persistent storage, HMAC-chained
  append-only audit log, structured logs, redaction, CLI.
- Persistent memory, provider abstraction (offline + HTTP) with a router
  that refuses silent paid substitution, default-deny tool registry,
  per-task and global budgets, specialist agents (review, memory,
  research, router), orchestrator with declared limits and output-schema
  validation, cancellation and checkpoint/resume.
