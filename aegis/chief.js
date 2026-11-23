'use strict';

/**
 * The Chief (Phase 3) — a goal-level orchestrator above the Phase 2
 * Orchestrator.
 *
 * The Orchestrator runs ONE task under its declared limits. The Chief is
 * the layer that takes a whole goal:
 *
 *   1. DECOMPOSE — a mission (goal + granted scopes + work items) is
 *      routed, item by item, to specialist roles and turned into a task
 *      graph with explicit dependencies (`needs`).
 *   2. ENFORCE — before anything runs, every subtask is checked in code:
 *      a card must exist for the role, the action must be one of the
 *      card's declared `capabilities`, the subtask's boundary tag must be
 *      one of the card's `scopes`, and that tag must be inside the
 *      mission's granted scopes. A violation refuses the whole mission.
 *      The same checks run again at dispatch time (defence in depth), so
 *      a graph mutated between planning and running is still refused.
 *   3. DISPATCH — subtasks run in topological order through the existing
 *      Orchestrator, so manifest allowlists, budgets, schema validation
 *      and audit all apply unchanged. A subtask whose dependencies did
 *      not all succeed is SKIPPED, never run on partial inputs.
 *   4. VERIFY — a mission is only DONE when a separate verification pass
 *      confirms: every subtask reached a terminal result, every subtask
 *      succeeded, every success carries evidence and a non-null output,
 *      and every dispatch stayed inside the granted scopes. Anything
 *      else is NEEDS_REVIEW — the chief never marks its own homework
 *      done on trust.
 *
 * Every step is written to the append-only audit log (`chief.*` events)
 * when an Audit instance is wired in.
 *
 * Decomposition is deterministic and rule-based, like the Phase 1/2
 * agents: the same mission always decomposes to the same graph. There is
 * no LLM call in this layer.
 */

const crypto = require('node:crypto');
const { Task } = require('./task');
const { STATES } = require('./states');
const { loadCards } = require('./cards');

class ChiefError extends Error {
  constructor(message, { code = 'CHIEF_ERROR' } = {}) {
    super(message); this.name = 'ChiefError'; this.code = code;
  }
}

// ---- scope ----------------------------------------------------------------

/**
 * The boundary of one mission: the set of scope tags the operator granted.
 * Specialists carry their own scope tags on their cards; a subtask may run
 * only where the two sets intersect — and the intersection is computed by
 * this class, not by the specialist.
 */
class Scope {
  constructor(granted = []) {
    if (!Array.isArray(granted) || granted.some((g) => typeof g !== 'string')) {
      throw new ChiefError('scope grants must be an array of strings', { code: 'SCOPE_INVALID' });
    }
    this._granted = new Set(granted);
  }
  grants(tag) { return this._granted.has(tag); }
  list() { return [...this._granted]; }
  check(tag, what = 'subtask') {
    if (!this.grants(tag)) {
      throw new ChiefError(
        `${what} requires scope "${tag}", which this mission was not granted (granted: ${this.list().join(', ') || 'none'})`,
        { code: 'OUT_OF_SCOPE' },
      );
    }
  }
}

// ---- task graph -----------------------------------------------------------

class TaskGraph {
  constructor() {
    this._nodes = new Map(); // key -> node, insertion ordered
  }

  addNode(node) {
    if (!node || !node.key) throw new ChiefError('graph node requires a key', { code: 'GRAPH_INVALID' });
    if (this._nodes.has(node.key)) {
      throw new ChiefError(`duplicate subtask key "${node.key}"`, { code: 'GRAPH_INVALID' });
    }
    const dependsOn = [...(node.dependsOn || [])];
    this._nodes.set(node.key, { ...node, dependsOn });
    return this._nodes.get(node.key);
  }

  get(key) { return this._nodes.get(key) || null; }
  nodes() { return [...this._nodes.values()]; }
  keys() { return [...this._nodes.keys()]; }
  get size() { return this._nodes.size; }

  /**
   * Kahn's algorithm, ties broken by insertion order so the execution
   * order is deterministic for a given graph. Throws on unknown
   * dependencies and on cycles — a cyclic plan is refused, never run
   * partially in the hope it resolves itself.
   */
  topoOrder() {
    for (const node of this._nodes.values()) {
      for (const dep of node.dependsOn) {
        if (!this._nodes.has(dep)) {
          throw new ChiefError(
            `subtask "${node.key}" depends on unknown subtask "${dep}"`,
            { code: 'UNKNOWN_DEPENDENCY' },
          );
        }
      }
    }
    const indegree = new Map();
    const dependents = new Map();
    for (const node of this._nodes.values()) {
      indegree.set(node.key, node.dependsOn.length);
      for (const dep of node.dependsOn) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(node.key);
      }
    }
    const queue = this.keys().filter((k) => indegree.get(k) === 0);
    const order = [];
    while (queue.length > 0) {
      const key = queue.shift();
      order.push(key);
      for (const next of dependents.get(key) || []) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== this._nodes.size) {
      const stuck = this.keys().filter((k) => !order.includes(k));
      throw new ChiefError(
        `dependency cycle detected involving: ${stuck.join(', ')}`,
        { code: 'CYCLE' },
      );
    }
    return order;
  }
}

// ---- decomposition routing --------------------------------------------------

// First match wins. The patterns are deliberately narrow: a work item is
// only routed to a specialist whose card covers the resulting scope, and
// anything unrecognised falls back to the classifier (triage) rather than
// to a more powerful role.
const ROUTE_TABLE = [
  { role: 'summariser', action: 'summarise', scope: 'synthesis', re: /\b(summar|digest|condense|recap|write[- ]?up)\b/i, reason: 'item asks for a synthesis of earlier work' },
  { role: 'review', action: 'review', scope: 'code-review', re: /\b(review|patch|diff|pull request|lint)\b/i, reason: 'item asks for a structured review' },
  { role: 'memory', action: 'remember', scope: 'memory', re: /\b(remember|store|record|note)\b/i, reason: 'item asks to persist a fact' },
  { role: 'research', action: 'fetch', scope: 'research', re: /\b(fetch|download|https?|url)\b/i, reason: 'item names a remote resource to fetch' },
  { role: 'doctor', action: 'diagnose', scope: 'workspace', re: /\b(workspace|directories|doctor|diagnos|health check)\b/i, reason: 'item asks for a workspace check' },
  { role: 'classifier', action: 'classify', scope: 'triage', re: /\b(classif|triage|bucket|categor)\b/i, reason: 'item asks for classification' },
];

function routeItem(item) {
  if (item.role) {
    // An explicitly pinned route is honoured, but it is still checked
    // against the card and the mission scope by the caller — pinning a
    // role is a request, not a bypass.
    return {
      role: item.role,
      action: item.action || null,
      scope: item.scope || null,
      reason: 'route pinned by the mission author',
    };
  }
  const text = String(item.text || '');
  const match = ROUTE_TABLE.find((r) => r.re.test(text));
  if (match) return { role: match.role, action: match.action, scope: match.scope, reason: match.reason };
  return { role: 'classifier', action: 'classify', scope: 'triage', reason: 'no specialist rule matched; defaulted to triage' };
}

// ---- the chief --------------------------------------------------------------

class Chief {
  /**
   * @param {object} deps
   * @param {object} deps.orchestrator  a Phase 2 Orchestrator (runs subtasks)
   * @param {object} [deps.cards]       a CardRegistry (default: loadCards())
   * @param {object} [deps.audit]       an Audit instance for `chief.*` events
   */
  constructor({ orchestrator, cards, audit } = {}) {
    if (!orchestrator || typeof orchestrator.run !== 'function') {
      throw new ChiefError('Chief requires an orchestrator with a run() method', { code: 'CHIEF_CONFIG' });
    }
    this.orchestrator = orchestrator;
    this.cards = cards || loadCards();
    this.audit = audit || null;
    this._validateCards();
  }

  /**
   * A card is usable only if it agrees with the layers below it: the role
   * must be declared in the manifest, a handler must be registered, and
   * the card's tool allowlist must not exceed the manifest's. Checked once
   * at construction so a bad card fails fast, before any mission runs.
   */
  _validateCards() {
    const manifest = this.orchestrator.manifest;
    const registry = this.orchestrator.agentRegistry;
    for (const card of this.cards.all()) {
      const declared = manifest && manifest.get(card.role);
      if (!declared) {
        throw new ChiefError(
          `card "${card.role}": role is not declared in the orchestrator manifest`,
          { code: 'CARD_NOT_DECLARED' },
        );
      }
      if (!registry || !registry.get(card.role)) {
        throw new ChiefError(
          `card "${card.role}": no handler registered for this role`,
          { code: 'CARD_NO_RUNNER' },
        );
      }
      const manifestTools = new Set(declared.allowedTools || []);
      for (const tool of card.allowedTools) {
        if (!manifestTools.has(tool)) {
          throw new ChiefError(
            `card "${card.role}": allowedTools includes "${tool}", which the manifest does not allow for this role — a card may narrow the manifest, never widen it`,
            { code: 'CARD_EXCEEDS_MANIFEST' },
          );
        }
      }
    }
  }

  _audit(kind, payload) {
    if (this.audit) { try { this.audit.append({ kind, ...payload }); } catch {} }
  }

  /**
   * The three enforcement checks for one routed subtask. Used at
   * decomposition time and again at dispatch time.
   *
   * @returns the specialist card the subtask will run under
   */
  _enforce(route, scope, what) {
    const card = this.cards.get(route.role);
    if (!card) {
      throw new ChiefError(`${what}: no specialist card for role "${route.role}"`, { code: 'NO_CARD' });
    }
    if (!route.action || !card.capabilities.includes(route.action)) {
      throw new ChiefError(
        `${what}: action "${route.action}" is not in the "${route.role}" card's capabilities (${card.capabilities.join(', ')})`,
        { code: 'ACTION_NOT_ALLOWED' },
      );
    }
    if (!route.scope || !card.scopes.includes(route.scope)) {
      throw new ChiefError(
        `${what}: scope "${route.scope}" is outside the "${route.role}" card's boundary (${card.scopes.join(', ')})`,
        { code: 'OUT_OF_SCOPE' },
      );
    }
    scope.check(route.scope, what);
    return card;
  }

  /**
   * Turn a mission into a task graph without running anything.
   *
   * Mission shape:
   *   { id?, goal, scopes: [granted tags],
   *     work: [{ key?, text, input?, needs?: [keys], inputFrom?: [keys],
   *              role?, action?, scope? }] }
   *
   * `inputFrom` declares a data dependency in addition to `needs`: at
   * dispatch time the named subtasks' outputs are supplied to this
   * subtask as labelled `sections` (the summariser's input shape).
   */
  decompose(mission) {
    if (!mission || typeof mission !== 'object') {
      throw new ChiefError('mission must be an object', { code: 'MISSION_INVALID' });
    }
    if (!Array.isArray(mission.work) || mission.work.length === 0) {
      throw new ChiefError('mission.work must be a non-empty array', { code: 'MISSION_INVALID' });
    }
    const scope = new Scope(mission.scopes || []);
    const graph = new TaskGraph();
    mission.work.forEach((item, i) => {
      const key = item.key || `w${i + 1}`;
      const route = routeItem(item);
      try {
        this._enforce(route, scope, `subtask "${key}"`);
      } catch (err) {
        this._audit('chief.decompose_refused', {
          missionGoal: mission.goal || '', key, role: route.role,
          action: route.action, scope: route.scope, code: err.code, error: err.message,
        });
        throw err;
      }
      const dependsOn = [...new Set([...(item.needs || []), ...(item.inputFrom || [])])];
      graph.addNode({
        key,
        title: item.text || key,
        role: route.role,
        action: route.action,
        scope: route.scope,
        routeReason: route.reason,
        input: item.input || (item.text ? { text: item.text } : {}),
        inputFrom: item.inputFrom || [],
        dependsOn,
      });
    });
    graph.topoOrder(); // validates dependencies and refuses cycles up front
    return graph;
  }

  /**
   * Run a mission end to end and return the verified report. A refused
   * mission (scope, action, cycle, …) throws a ChiefError; a mission that
   * ran but did not pass verification resolves with status NEEDS_REVIEW.
   */
  async run(mission) {
    const missionId = mission.id || `m_${crypto.randomBytes(6).toString('hex')}`;
    const scope = new Scope(mission.scopes || []);
    this._audit('chief.mission_start', { missionId, goal: mission.goal || '', grantedScopes: scope.list() });

    const graph = this.decompose(mission);
    const order = graph.topoOrder();
    this._audit('chief.decomposed', {
      missionId,
      subtasks: graph.nodes().map((n) => ({ key: n.key, role: n.role, action: n.action, scope: n.scope, dependsOn: n.dependsOn })),
      order,
    });

    const results = new Map(); // key -> { status, output, evidence, error }
    for (const key of order) {
      const node = graph.get(key);
      const unmet = node.dependsOn.filter((d) => {
        const r = results.get(d);
        return !r || r.status !== STATES.SUCCEEDED;
      });
      if (unmet.length > 0) {
        results.set(key, { status: 'SKIPPED', output: null, evidence: [], error: `dependencies not satisfied: ${unmet.join(', ')}` });
        this._audit('chief.skipped', { missionId, key, unmet });
        continue;
      }

      // Defence in depth: the graph was checked at decomposition, but it
      // is checked again here, at the moment of dispatch, so nothing that
      // changed in between can widen what actually runs.
      try {
        this._enforce({ role: node.role, action: node.action, scope: node.scope }, scope, `subtask "${key}"`);
      } catch (err) {
        results.set(key, { status: 'REFUSED', output: null, evidence: [], error: err.message });
        this._audit('chief.dispatch_refused', { missionId, key, code: err.code, error: err.message });
        continue;
      }

      const input = { ...node.input };
      if (node.inputFrom.length > 0) {
        input.sections = node.inputFrom.map((from) => ({
          label: from,
          body: stringifyOutput(results.get(from) && results.get(from).output),
        }));
      }

      this._audit('chief.dispatch', { missionId, key, role: node.role, action: node.action, scope: node.scope });
      const task = new Task({ title: node.title, role: node.role, goal: mission.goal || '', input });
      try {
        const result = await this.orchestrator.run(task);
        results.set(key, {
          status: result.status,
          output: result.output != null ? result.output : null,
          evidence: result.evidence || [],
          error: result.error || null,
        });
        this._audit('chief.result', { missionId, key, status: result.status });
      } catch (err) {
        results.set(key, { status: STATES.FAILED, output: null, evidence: [], error: String((err && err.message) || err) });
        this._audit('chief.result', { missionId, key, status: STATES.FAILED, error: String((err && err.message) || err) });
      }
    }

    const verification = this.verify(mission, graph, results);
    const status = verification.verified ? 'DONE' : 'NEEDS_REVIEW';
    this._audit(verification.verified ? 'chief.verified' : 'chief.verification_failed', {
      missionId, checks: verification.checks.map((c) => ({ id: c.id, ok: c.ok })),
    });

    const report = {
      missionId,
      goal: mission.goal || '',
      status,
      subtasks: graph.nodes().map((n) => {
        const r = results.get(n.key);
        return {
          key: n.key, role: n.role, action: n.action, scope: n.scope,
          status: r.status, output: r.output, evidenceCount: (r.evidence || []).length,
          error: r.error || null,
        };
      }),
      verification,
    };
    this._audit('chief.mission_done', { missionId, status });
    return report;
  }

  /**
   * The verification pass. Independent of the dispatch loop's own
   * bookkeeping: it re-derives every claim from the graph and the results
   * map, so a bug in dispatch shows up here instead of being trusted.
   */
  verify(mission, graph, results) {
    const granted = new Scope(mission.scopes || []);
    const nodes = graph.nodes();
    const checks = [];

    const missing = nodes.filter((n) => !results.has(n.key)).map((n) => n.key);
    checks.push({
      id: 'all-subtasks-accounted',
      ok: missing.length === 0,
      detail: missing.length ? `no result recorded for: ${missing.join(', ')}` : `${nodes.length} subtask(s) all have results`,
    });

    const notSucceeded = nodes
      .filter((n) => results.has(n.key) && results.get(n.key).status !== STATES.SUCCEEDED)
      .map((n) => `${n.key} (${results.get(n.key).status})`);
    checks.push({
      id: 'all-subtasks-succeeded',
      ok: notSucceeded.length === 0,
      detail: notSucceeded.length ? `not succeeded: ${notSucceeded.join(', ')}` : 'every subtask succeeded',
    });

    const noEvidence = nodes
      .filter((n) => results.has(n.key) && results.get(n.key).status === STATES.SUCCEEDED
        && (!Array.isArray(results.get(n.key).evidence) || results.get(n.key).evidence.length === 0))
      .map((n) => n.key);
    checks.push({
      id: 'evidence-present',
      ok: noEvidence.length === 0,
      detail: noEvidence.length ? `succeeded without evidence: ${noEvidence.join(', ')}` : 'every success carries evidence',
    });

    const noOutput = nodes
      .filter((n) => results.has(n.key) && results.get(n.key).status === STATES.SUCCEEDED
        && results.get(n.key).output == null)
      .map((n) => n.key);
    checks.push({
      id: 'outputs-present',
      ok: noOutput.length === 0,
      detail: noOutput.length ? `succeeded with a null output: ${noOutput.join(', ')}` : 'every success produced an output',
    });

    const outOfScope = nodes.filter((n) => !granted.grants(n.scope)).map((n) => `${n.key} (${n.scope})`);
    checks.push({
      id: 'within-granted-scope',
      ok: outOfScope.length === 0,
      detail: outOfScope.length ? `outside the granted scopes: ${outOfScope.join(', ')}` : 'every subtask stayed inside the granted scopes',
    });

    return { verified: checks.every((c) => c.ok), checks };
  }
}

function stringifyOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output, null, 2); } catch { return String(output); }
}

/**
 * The demo mission used by `examples/chief-demo.js` and the test suite.
 * Four subtasks, three specialists plus the summariser, one explicit
 * dependency chain (the digest consumes the other three).
 */
function sampleMission(root) {
  const finding = 'Classify this finding: possible IDOR on the login session token endpoint';
  const patch = [
    'diff --git a/src/session.js b/src/session.js',
    '+  const token = issueToken(user.id);',
    '+  console.log("issued token for", user.id);',
    '+  return { token, expiresIn: 3600 };',
  ].join('\n');
  return {
    goal: 'Assess the staging login change before it ships',
    scopes: ['triage', 'code-review', 'workspace', 'synthesis'],
    work: [
      { key: 'triage', text: finding, input: { text: finding } },
      { key: 'patch-review', text: 'Review this patch before merge', input: { text: patch } },
      { key: 'workspace', text: 'Check the workspace directories are present', input: { root } },
      {
        key: 'digest',
        text: 'Summarise the findings into a digest',
        needs: ['triage', 'patch-review', 'workspace'],
        inputFrom: ['triage', 'patch-review', 'workspace'],
      },
    ],
  };
}

module.exports = { Chief, ChiefError, Scope, TaskGraph, routeItem, ROUTE_TABLE, sampleMission };
