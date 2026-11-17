// Unified pre-send Privacy Guard.
//
// One detector catalogue, one vault, one gate — shared by the chat wire, image
// and video prompts, tool results, memory writes, document exports and logs. The
// old split (six PII regexes in `lib/pii-mask.mjs`, a separate credential list in
// `memory/guard.mjs`, and nothing at all on documents or logs) is what let a real
// API key pass the gate while a `127.0.0.1` was masked out of the server.
//
// Entry points:
//   screenOutbound()      the pre-send gate (block / mask / re-verify)
//   maskString()          one string, dual-form pseudonyms
//   sanitizeText()        artifacts and logs: deterministic, vault-free
//   redactForLog()        logs: credentials removed outright
//   createPiiMaskContext() back-compat session view used by lib/inference.mjs

export * from './detectors.mjs';
export * from './vault.mjs';
export * from './mask.mjs';
export * from './envelope.mjs';
export * from './slm.mjs';
export * from './gate.mjs';
export { tokenizerStatus, tokenEfficiency, entropyBits, countTokens } from './tokenizer.mjs';

import {
  RULE_RRN, RULE_CARD, RULE_EMAIL, RULE_IPV4, RULE_PHONE, RULE_ACCOUNT,
} from './detectors.mjs';
import { createVault, getVault } from './vault.mjs';
import { maskString, restoreString, createStreamRestorer as streamRestorerFor } from './mask.mjs';
import { mapEnvelope, restoreDeep } from './envelope.mjs';
import { detectAll } from './detectors.mjs';

/** The six rules the pre-unification pass shipped, kept for compatibility. */
export const PII_RULES = Object.freeze([RULE_RRN, RULE_CARD, RULE_EMAIL, RULE_IPV4, RULE_PHONE, RULE_ACCOUNT]);

/** Accept a vault, a bare `Map`, or nothing (one-shot vault) and return a vault. */
function asVault(value) {
  if (!value) return createVault(null);
  if (typeof value.allocate === 'function' && value.mapping instanceof Map) return value;
  if (value.vault && typeof value.vault.allocate === 'function') return value.vault;
  if (value instanceof Map || value.mapping instanceof Map) {
    // A bare `Map` (an older context, or a caller restoring one mapping): adapt it.
    const mapping = value instanceof Map ? value : value.mapping;
    return {
      mapping,
      counts: value.counts ?? {},
      get size() { return mapping.size; },
      allocate(rule, original) {
        const placeholder = `__PII_${String(rule).toUpperCase()}_${mapping.size + 1}__`;
        mapping.set(placeholder, original);
        return placeholder;
      },
      lookup(rule, rawValue) {
        for (const original of mapping.values()) if (original === rawValue) return { value: original };
        return null;
      },
      originals() { return [...mapping.values()]; },
      fingerprint() { return 'unsessioned'; },
    };
  }
  return getVault(null);
}

/**
 * Session view over the shared vault. This is the object `lib/inference.mjs` used
 * to create per request; it is now session-scoped, so a phone number keeps its
 * index across turns instead of restarting at `PHONE_1` every request.
 */
export function createPiiMaskContext(sessionId = null) {
  const vault = getVault(sessionId);
  return {
    sessionId,
    vault,
    get mapping() { return vault.mapping; },
    get counts() { return vault.counts; },
    get size() { return vault.size; },
    allocatePlaceholder(rule, original) { return vault.allocate(rule, original, { form: 'code' }); },
    fingerprint(...parts) { return vault.fingerprint(...parts); },
    clear() { vault.mapping.clear(); vault.byKey.clear(); },
  };
}

/** Mask plain text; returns the masked string (back-compat signature). */
export function maskText(text, context) {
  const vault = asVault(context);
  return maskString(text, vault, { kind: 'text' }).text;
}

/** Mask every slot in a message list: content, array parts, tool_calls, tool payloads. */
export function maskMessages(messages, context) {
  const vault = asVault(context);
  if (!Array.isArray(messages)) return messages;
  return mapEnvelope({ messages }, (text, meta) => maskString(text, vault, { kind: meta.kind }).text).messages;
}

export function restoreText(text, context) {
  return restoreString(text, asVault(context));
}

/** Restore placeholders anywhere in a chat-completion payload. */
export function restoreJsonPayload(payload, context) {
  if (!payload || typeof payload !== 'object') return payload;
  return restoreDeep(payload, (text) => restoreString(text, asVault(context)));
}

/** Streaming restorer over the session vault's placeholders. */
export function createStreamRestorer(context) {
  return streamRestorerFor(asVault(context));
}

/**
 * Deterministic sanitizer for artifacts (HTML/PDF), documents and anything that
 * is written once and hashed. No session vault is involved, and the counter starts
 * at zero every call, so the same input always yields the same output — which is
 * what keeps `contentHashFor` stable over the sanitized projection.
 */
export function sanitizeText(text, { hint = '' } = {}) {
  const source = String(text ?? '');
  if (!source) return { text: source, rules: [], counts: {}, total: 0 };
  const vault = createVault(null);
  const masked = maskString(source, vault, { kind: 'text', hint });
  const rules = [...new Set(masked.hits.map((hit) => hit.rule))].sort();
  const counts = {};
  for (const hit of masked.hits) counts[hit.rule] = (counts[hit.rule] ?? 0) + 1;
  return { text: masked.text, rules, counts, total: masked.hits.length };
}

/** Deterministic scan without masking: used to decide whether to sanitize at all. */
export function scanText(text, options = {}) {
  return detectAll(String(text ?? ''), options);
}
