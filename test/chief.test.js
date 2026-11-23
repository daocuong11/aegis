'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Chief, ChiefError, Scope, TaskGraph, routeItem, sampleMission } = require('../aegis/chief');
const { CardRegistry, CardError, loadCards, validateCard } = require('../aegis/cards');
const { Orchestrator, buildDefaultManifest } = require('../aegis/orchestrator');
const { Agent, AgentRegistry, buildDefaultRegistry } = require('../aegis/agent');
const { buildDefaultRegistry: buildTools } = require('../aegis/tools/registry');
const { Audit } = require('../aegis/audit');
const { STATES } = require('../aegis/states');

function mkChief(opts = {}) {
  const agentRegistry = opts.agentRegistry || buildDefaultRegistry();
  const orchestrator = new Orchestrator({
    manifest: opts.manifest || buildDefaultManifest(agentRegistry),
    agentRegistry,
    toolRegistry: buildTools(),
    audit: opts.audit || null,
  });
  return new Chief({ orchestrator, cards: opts.cards, audit: opts.audit || null });
}


function cardsFor(...roles) {
  const all = loadCards();
  const reg = new CardRegistry();
  for (const role of roles) reg.add(all.get(role));
  return reg;
}

function tmpAudit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-chief-test-'));
  return new Audit(path.join(dir, 'audit.log'));
}

function workspaceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-chief-ws-'));
  for (const d of ['state', 'data', 'logs', 'docs']) fs.mkdirSync(path.join(dir, d));
  return dir;
}

// ---- cards ---------------------------------------------------------------

test('cards: the shipped cards load and validate', () => {
  const cards = loadCards();
  assert.deepEqual(cards.list().sort(), ['classifier', 'doctor', 'memory', 'research', 'review', 'summariser']);
  for (const card of cards.all()) {
    assert.ok(card.capabilities.length > 0);
    assert.ok(card.scopes.length > 0);
    assert.ok(Object.isFrozen(card), `card ${card.role} must be frozen`);
  }
});

test('cards: validation rejects a card with a missing field', () => {
  assert.throws(
    () => validateCard({ role: 'x', purpose: 'p' }),
    (err) => err instanceof CardError && err.code === 'CARD_INVALID',
  );
});

test('cards: validation rejects empty capabilities and empty scopes', () => {
  const base = { role: 'x', purpose: 'p', capabilities: ['a'], allowedTools: [], scopes: ['s'] };
  assert.throws(() => validateCard({ ...base, capabilities: [] }), (err) => err.code === 'CARD_INVALID');
  assert.throws(() => validateCard({ ...base, scopes: [] }), (err) => err.code === 'CARD_INVALID');
});

test('cards: duplicate roles are rejected', () => {
  const reg = new CardRegistry();
  const card = { role: 'x', purpose: 'p', capabilities: ['a'], allowedTools: [], scopes: ['s'] };
  reg.add(card);
  assert.throws(() => reg.add(card), (err) => err.code === 'CARD_DUPLICATE');
});

test('chief: a card that widens the manifest tool allowlist is refused at construction', () => {
  const cards = loadCards();
  const tampered = new CardRegistry();
  for (const card of cards.all()) {
    tampered.add(card.role === 'review' ? { ...card, allowedTools: ['http.get'] } : card);
  }
  assert.throws(() => mkChief({ cards: tampered }), (err) => err.code === 'CARD_EXCEEDS_MANIFEST');
});

test('chief: a card for an undeclared role is refused at construction', () => {
  const cards = loadCards();
  const withGhost = new CardRegistry();
  for (const card of cards.all()) withGhost.add(card);
  withGhost.add({ role: 'ghost', purpose: 'p', capabilities: ['haunt'], allowedTools: [], scopes: ['triage'] });
  assert.throws(() => mkChief({ cards: withGhost }), (err) => err.code === 'CARD_NOT_DECLARED');
});

// ---- decomposition ---------------------------------------------------------

test('decompose: the sample mission becomes a graph with the right roles, actions and scopes', () => {
  const chief = mkChief();
  const graph = chief.decompose(sampleMission(workspaceFixture()));
  assert.equal(graph.size, 4);
  assert.deepEqual(
    graph.nodes().map((n) => [n.key, n.role, n.action, n.scope]),
    [
      ['triage', 'classifier', 'classify', 'triage'],
      ['patch-review', 'review', 'review', 'code-review'],
      ['workspace', 'doctor', 'diagnose', 'workspace'],
      ['digest', 'summariser', 'summarise', 'synthesis'],
    ],
  );
  assert.deepEqual(graph.get('digest').dependsOn.sort(), ['patch-review', 'triage', 'workspace']);
});

test('decompose: topological order runs dependencies before dependents', () => {
  const graph = new TaskGraph();
  graph.addNode({ key: 'b', dependsOn: ['a'] });
  graph.addNode({ key: 'a', dependsOn: [] });
  graph.addNode({ key: 'c', dependsOn: ['b'] });
  assert.deepEqual(graph.topoOrder(), ['a', 'b', 'c']);
});

test('decompose: a dependency cycle is refused', () => {
  const chief = mkChief();
  const mission = {
    goal: 'loop',
    scopes: ['triage'],
    work: [
      { key: 'a', text: 'Classify this', needs: ['b'] },
      { key: 'b', text: 'Classify that', needs: ['a'] },
    ],
  };
  assert.throws(() => chief.decompose(mission), (err) => err.code === 'CYCLE');
});

test('decompose: an unknown dependency is refused', () => {
  const chief = mkChief();
  const mission = {
    goal: 'gap',
    scopes: ['triage'],
    work: [{ key: 'a', text: 'Classify this', needs: ['nope'] }],
  };
  assert.throws(() => chief.decompose(mission), (err) => err.code === 'UNKNOWN_DEPENDENCY');
});

test('routing: unrecognised work falls back to triage, never to a stronger role', () => {
  const route = routeItem({ text: 'Wobble the framistan gently' });
  assert.equal(route.role, 'classifier');
  assert.equal(route.scope, 'triage');
});

// ---- scope + action enforcement ---------------------------------------------

test('scope: a subtask outside the granted scopes refuses the whole mission', async () => {
  const audit = tmpAudit();
  const chief = mkChief({ audit });
  const mission = sampleMission(workspaceFixture());
  mission.scopes = mission.scopes.filter((s) => s !== 'code-review');
  await assert.rejects(() => chief.run(mission), (err) => err.code === 'OUT_OF_SCOPE');
  const kinds = audit.read().map((r) => r.event.kind);
  assert.ok(kinds.includes('chief.decompose_refused'), 'the refusal must be audited');
  audit.close();
});

test('scope: a pinned route outside the card boundary is refused', () => {
  const chief = mkChief();
  const mission = {
    goal: 'sneaky',
    scopes: ['triage', 'code-review'],
    work: [{ key: 'x', text: 'do it', role: 'review', action: 'review', scope: 'triage' }],
  };
  assert.throws(() => chief.decompose(mission), (err) => err.code === 'OUT_OF_SCOPE');
});

test('scope: an action outside the card capabilities is refused', () => {
  const chief = mkChief();
  const mission = {
    goal: 'sneaky',
    scopes: ['triage', 'research'],
    work: [{ key: 'x', text: 'do it', role: 'review', action: 'fetch', scope: 'code-review' }],
  };
  assert.throws(() => chief.decompose(mission), (err) => err.code === 'ACTION_NOT_ALLOWED');
});

test('scope: a role with no card is refused', () => {
  const chief = mkChief();
  const mission = {
    goal: 'sneaky',
    scopes: ['triage'],
    work: [{ key: 'x', text: 'do it', role: 'fail', action: 'classify', scope: 'triage' }],
  };
  assert.throws(() => chief.decompose(mission), (err) => err.code === 'NO_CARD');
});

test('scope: Scope.check names the missing grant', () => {
  const scope = new Scope(['triage']);
  assert.equal(scope.grants('triage'), true);
  assert.throws(() => scope.check('payments'), (err) => err.code === 'OUT_OF_SCOPE' && /payments/.test(err.message));
});

// ---- execution ---------------------------------------------------------------

test('run: the demo mission completes DONE with a passing verification', async () => {
  const chief = mkChief();
  const report = await chief.run(sampleMission(workspaceFixture()));
  assert.equal(report.status, 'DONE');
  assert.equal(report.verification.verified, true);
  assert.ok(report.verification.checks.every((c) => c.ok));
  assert.deepEqual(report.subtasks.map((s) => s.status), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  const digest = report.subtasks.find((s) => s.key === 'digest');
  assert.equal(digest.output.sections.length, 3, 'the digest must consume the three earlier outputs');
});

test('run: dependencies execute before dependents, whatever order the mission lists them in', async () => {
  const calls = [];
  const registry = new AgentRegistry();
  registry.register(new Agent('classifier', async () => {
    calls.push('classifier');
    return { status: STATES.SUCCEEDED, output: { buckets: ['general'] }, evidence: [{ kind: 'classification' }] };
  }));
  registry.register(new Agent('review', async () => {
    calls.push('review');
    return { status: STATES.SUCCEEDED, output: { score: 100, summary: 'ok', blockers: [], nits: [] }, evidence: [{ kind: 'review' }] };
  }));
  const chief = mkChief({ agentRegistry: registry, cards: cardsFor('classifier', 'review') });
  const mission = {
    goal: 'order matters',
    scopes: ['triage', 'code-review'],
    work: [
      { key: 'second', text: 'Review this patch', needs: ['first'], input: { text: 'patch' } },
      { key: 'first', text: 'Classify this finding', input: { text: 'finding' } },
    ],
  };
  const report = await chief.run(mission);
  assert.equal(report.status, 'DONE');
  assert.deepEqual(calls, ['classifier', 'review']);
});

test('run: a failed dependency skips its dependents and the mission is NEEDS_REVIEW, never DONE', async () => {
  const registry = new AgentRegistry();
  registry.register(new Agent('classifier', async () => ({
    status: STATES.FAILED, output: null, error: 'boom', evidence: [{ kind: 'forced' }],
  })));
  registry.register(new Agent('summariser', async () => ({
    status: STATES.SUCCEEDED, output: { sections: [], totalWords: 0 }, evidence: [{ kind: 'summarise' }],
  })));
  const chief = mkChief({ agentRegistry: registry, cards: cardsFor('classifier', 'summariser') });
  const mission = {
    goal: 'will fail',
    scopes: ['triage', 'synthesis'],
    work: [
      { key: 'a', text: 'Classify this finding', input: { text: 'x' } },
      { key: 'b', text: 'Summarise the findings', needs: ['a'], inputFrom: ['a'] },
    ],
  };
  const report = await chief.run(mission);
  assert.equal(report.status, 'NEEDS_REVIEW');
  assert.equal(report.verification.verified, false);
  assert.equal(report.subtasks.find((s) => s.key === 'b').status, 'SKIPPED');
  const failed = report.verification.checks.find((c) => c.id === 'all-subtasks-succeeded');
  assert.equal(failed.ok, false);
});

test('run: every delegation and result lands in the audit log, in order', async () => {
  const audit = tmpAudit();
  const chief = mkChief({ audit });
  await chief.run(sampleMission(workspaceFixture()));
  const kinds = audit.read().map((r) => r.event.kind).filter((k) => k.startsWith('chief.'));
  assert.equal(kinds[0], 'chief.mission_start');
  assert.ok(kinds.includes('chief.decomposed'));
  assert.equal(kinds.filter((k) => k === 'chief.dispatch').length, 4);
  assert.equal(kinds.filter((k) => k === 'chief.result').length, 4);
  assert.ok(kinds.includes('chief.verified'));
  assert.equal(kinds[kinds.length - 1], 'chief.mission_done');
  assert.equal(audit.verify().ok, true, 'the audit chain must verify after a chief run');
  audit.close();
});

test('verify: a results map that claims success outside the granted scopes fails verification', () => {
  const chief = mkChief();
  const graph = chief.decompose(sampleMission(workspaceFixture()));
  const results = new Map(graph.nodes().map((n) => [n.key, {
    status: STATES.SUCCEEDED, output: { ok: true }, evidence: [{ kind: 'x' }], error: null,
  }]));
  const narrowed = { ...sampleMission(workspaceFixture()), scopes: ['triage', 'workspace', 'synthesis'] };
  const v = chief.verify(narrowed, graph, results);
  assert.equal(v.verified, false);
  assert.equal(v.checks.find((c) => c.id === 'within-granted-scope').ok, false);
});
