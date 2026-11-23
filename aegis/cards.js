'use strict';

/**
 * Specialist cards (Phase 3).
 *
 * A *card* is the data-file declaration of one specialist: its role, what
 * it is for, the actions it may perform (`capabilities`), the tools it may
 * touch (`allowedTools`), and the boundary tags it may work inside
 * (`scopes`). Cards live as JSON in `aegis/cards/` — the same pattern as
 * gravion-hunter's specialist cards, made machine-readable so the chief
 * can enforce them in code instead of trusting a prompt.
 *
 * A card is an allowlist, never a grant by itself. The chief additionally
 * requires, before any card is usable:
 *   - the role is declared in the orchestrator manifest,
 *   - a handler is registered for the role,
 *   - the card's `allowedTools` are a subset of the manifest's
 *     `allowedTools` for that role (a card may narrow, never widen).
 */

const fs = require('node:fs');
const path = require('node:path');

const CARD_DIR = path.join(__dirname, 'cards');

const REQUIRED_FIELDS = ['role', 'purpose', 'capabilities', 'allowedTools', 'scopes'];

class CardError extends Error {
  constructor(message, { code = 'CARD_ERROR' } = {}) {
    super(message); this.name = 'CardError'; this.code = code;
  }
}

function validateCard(card, source = '<inline>') {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new CardError(`card ${source}: must be a JSON object`, { code: 'CARD_INVALID' });
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in card)) {
      throw new CardError(`card ${source}: missing field "${f}"`, { code: 'CARD_INVALID' });
    }
  }
  if (typeof card.role !== 'string' || card.role.length === 0) {
    throw new CardError(`card ${source}: role must be a non-empty string`, { code: 'CARD_INVALID' });
  }
  for (const f of ['capabilities', 'allowedTools', 'scopes']) {
    if (!Array.isArray(card[f]) || card[f].some((v) => typeof v !== 'string')) {
      throw new CardError(`card ${source}: ${f} must be an array of strings`, { code: 'CARD_INVALID' });
    }
  }
  if (card.capabilities.length === 0) {
    throw new CardError(`card ${source}: capabilities must not be empty — a specialist that can do nothing is a declaration bug`, { code: 'CARD_INVALID' });
  }
  if (card.scopes.length === 0) {
    throw new CardError(`card ${source}: scopes must not be empty — a specialist with no boundary is not allowed`, { code: 'CARD_INVALID' });
  }
  return card;
}

class CardRegistry {
  constructor() { this._byRole = new Map(); }
  add(card, source) {
    validateCard(card, source);
    if (this._byRole.has(card.role)) {
      throw new CardError(`duplicate card for role "${card.role}"`, { code: 'CARD_DUPLICATE' });
    }
    // Freeze a copy: a card is a declaration, and declarations do not
    // change at runtime because a caller mutated the object it loaded.
    const frozen = Object.freeze({
      ...card,
      capabilities: Object.freeze([...card.capabilities]),
      allowedTools: Object.freeze([...card.allowedTools]),
      scopes: Object.freeze([...card.scopes]),
    });
    this._byRole.set(card.role, frozen);
    return frozen;
  }
  get(role) { return this._byRole.get(role) || null; }
  list() { return [...this._byRole.keys()]; }
  all() { return [...this._byRole.values()]; }
}

/**
 * Load every `*.json` card from a directory (default: `aegis/cards/`).
 * Files are read in sorted order so the registry is deterministic.
 */
function loadCards(dir = CARD_DIR) {
  const registry = new CardRegistry();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const full = path.join(dir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch (err) {
      throw new CardError(`card ${file}: not valid JSON (${err.message})`, { code: 'CARD_INVALID' });
    }
    registry.add(parsed, file);
  }
  return registry;
}

module.exports = { CardRegistry, CardError, validateCard, loadCards, CARD_DIR };
