'use strict';

/**
 * Chief demo (Phase 3) — `npm run demo:chief`.
 *
 * Runs the sample mission end to end against the real, deterministic
 * specialists: the classifier triages a finding, the reviewer scores a
 * patch, the diagnostician checks this workspace, and the summariser
 * digests the three outputs — in dependency order, inside the mission's
 * granted scopes, with a verification pass before the chief calls it
 * done. Then it runs the same mission with one scope grant removed, to
 * show the refusal path.
 *
 * Everything is local and offline. The audit trail for the run is written
 * to a temporary directory and its location printed, so the demo leaves
 * the workspace exactly as it found it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Audit } = require('../aegis/audit');
const { Orchestrator, buildDefaultManifest } = require('../aegis/orchestrator');
const { buildDefaultRegistry } = require('../aegis/agent');
const { buildDefaultRegistry: buildTools } = require('../aegis/tools/registry');
const { Chief, sampleMission } = require('../aegis/chief');

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-chief-demo-'));
  const audit = new Audit(path.join(tmp, 'audit.log'));
  const agentRegistry = buildDefaultRegistry();
  const orchestrator = new Orchestrator({
    manifest: buildDefaultManifest(agentRegistry),
    agentRegistry,
    toolRegistry: buildTools(),
  });
  const chief = new Chief({ orchestrator, audit });

  console.log('=== AEGIS Chief demo ===\n');

  const mission = sampleMission(repoRoot);
  console.log(`Goal: ${mission.goal}`);
  console.log(`Granted scopes: ${mission.scopes.join(', ')}\n`);

  const report = await chief.run(mission);
  for (const st of report.subtasks) {
    console.log(`[${st.status}] ${st.key} — ${st.role}/${st.action} (scope: ${st.scope}, evidence: ${st.evidenceCount})`);
    console.log(`        ${JSON.stringify(st.output)}`);
  }
  console.log('\nVerification:');
  for (const c of report.verification.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail}`);
  }
  console.log(`\nMission status: ${report.status}`);

  console.log('\n--- refusal path: same mission, "code-review" grant removed ---');
  const narrowed = { ...sampleMission(repoRoot), scopes: ['triage', 'workspace', 'synthesis'] };
  try {
    await chief.run(narrowed);
    console.log('ERROR: the narrowed mission should have been refused');
    process.exitCode = 1;
  } catch (err) {
    console.log(`Refused as designed: [${err.code}] ${err.message}`);
  }

  const chain = audit.verify();
  console.log(`\nAudit trail: ${audit.filePath}`);
  console.log(`Audit chain: ${chain.checked} events, integrity ${chain.ok ? 'OK' : 'BROKEN'}`);
  audit.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
