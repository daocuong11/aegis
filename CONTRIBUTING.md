# Contributing to Project AEGIS

Thanks for helping! Project AEGIS is a multi-agent AI system built
around one rule: **the system must be safe and correct before it is
clever.** Every capability an agent can reach is declared, scoped,
limited, audited and recoverable.

The most valuable contributions are new scoped capabilities with
tests, hardening of the audit/redaction paths, and regression tests
that pin down a failure mode forever.

## Ground rules

- **Zero runtime dependencies — hard rule.** Node.js built-ins only.
- **No capability without a scope.** A tool an agent can call must be
  declared, limited and audited. A contribution that widens what an
  agent can do *without* going through the scope/audit machinery will
  not be merged.
- **No credentials in the tree.** CI asserts this
  (`node scripts/scan-secrets.js`) and runs an offline provider smoke
  check with empty credentials. Keep it that way: tests must pass
  with no keys and no network.

## Development setup

Requires Node.js 18 or newer. There is nothing to install:

```bash
git clone https://github.com/gravion-ux/aegis.git
cd aegis
npm test
```

## Running the tests

```bash
npm test                 # the full suite (this is what CI runs)
npm run test:phase1      # the Phase 1 compatibility suite
npm run test:security    # security-hardening tests only
npm run test:adversarial # adversarial tests only
```

Useful smoke checks, also run by CI:

```bash
node aegis/cli.js providers smoke   # offline, no credentials
node aegis/cli.js doctor
node scripts/scan-secrets.js        # must report a clean tree
```

CI runs the suite on Node 18, 20 and 22.

## Code style

- Plain Node.js, no build step, no transpiler.
- Tests live in `test/` and run on the built-in `node --test`
  runner. Name new test files `*.test.js` and add them to the
  relevant `npm` test script in `package.json` — the scripts list
  files explicitly, so an unlisted test file never runs.
- Comments explain *why* a limit, scope or redaction rule exists.

## Proposing a bigger change

Anything that changes the capability/scope model, the audit format,
or recovery semantics: **open an issue first**. Tests, fixes and
documentation can go straight to a pull request.

## Pull request workflow

1. Fork and branch from `main`: `feat/<short-name>`,
   `fix/<short-name>`, `test/<short-name>`, `docs/<short-name>`.
2. Run the full suite locally, plus the three smoke checks above.
3. Open the PR against `main` with: what changed, why, how you
   tested it — and, for capability changes, what scope and audit
   coverage the new capability has.
4. CI must be green. One logical change per PR.
