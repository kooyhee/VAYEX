// The pre-send gate.
//
// Order matters, and it is the order the audit asked for:
//   1. detect on the whole envelope (personal, credential, project data),
//   2. refuse a confirmed secret — default action BLOCK, never "send anyway",
//   3. refuse an ambiguous high-risk span that cannot be verified (fail closed),
//   4. refuse an attachment that cannot be inspected on a cloud route,
//   5. pseudonymize everything that is maskable,
//   6. re-verify the serialized wire payload and refuse if anything survived.
//
// Every step reports rule ids, counts, field paths and an 8-hex HMAC fingerprint.
// The raw value never leaves this module.

import { AsyncLocalStorage } from 'node:async_hooks';
import { detectAll, AMBIGUOUS_HIGH, AMBIGUOUS_LOW } from './detectors.mjs';
import { collectStrings, mapEnvelope } from './envelope.mjs';
import { shieldRanges, shielded } from './shield.mjs';
import { getVault, createVault } from './vault.mjs';
import { maskString, restoreString } from './mask.mjs';
import { probeSlm, verifyHighRisk, isAmbiguous } from './slm.mjs';
import { emitEvent } from '../../gateway/lib/events.mjs';

export const PRIVACY_CODES = Object.freeze({
  blocked: 'privacy_guard_blocked',
  recheck: 'privacy_guard_recheck_failed',
  unverifiable: 'privacy_guard_unverifiable_high_risk',
  invalid: 'privacy_guard_invalid_request',
});

export const PRIVACY_STATUS = Object.freeze({ blocked: 422 });

const CLOUD_ROUTES = new Set(['openrouter-zdr', 'a6api', 'opencodex-nace', 'any_cloud', 'zdr_cloud']);

export function isCloudRoute(route) {
  return CLOUD_ROUTES.has(String(route ?? '')) || String(route ?? '') !== 'local_only';
}

/** Every finding in a request body, each carrying the field path it came from. */
export function scanEnvelope(body, { route = 'local_only' } = {}) {
  const findings = [];
  for (const slot of collectStrings(body)) {
    const found = detectAll(slot.value, { path: slot.path, hint: `${slot.kind} ${slot.detectionHint ?? slot.path}` });
    for (const finding of found) findings.push({ ...finding, slotKind: slot.kind });
  }
  return findings;
}

/** Attachments whose bytes cannot be inspected: refuse them on a cloud route. */
export function attachmentProblems(body, route = 'local_only') {
  if (!isCloudRoute(route)) return [];
  const problems = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || !Array.isArray(message.content)) continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex];
      if (!part || typeof part !== 'object') continue;
      const path = `messages[${messageIndex}].content[${partIndex}]`;
      if (part.type === 'input_audio') {
        problems.push({ path, kind: 'audio_attachment', reason: 'audio bytes cannot be screened' });
        continue;
      }
      if (part.type === 'file' && (part.file?.file_data || part.file_data)) {
        problems.push({ path, kind: 'file_attachment', reason: 'file bytes cannot be screened' });
        continue;
      }
      if (part.type === 'image_url' || part.type === 'input_image') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url ?? '';
        if (typeof url !== 'string' || url === '') continue;
        if (/^https?:/i.test(url)) continue;
        if (/^data:(?:image|audio|text)\//i.test(url)) continue;
        problems.push({ path, kind: 'unparseable_attachment', reason: 'attachment is neither an http URL nor a typed data URL' });
      }
    }
  }
  return problems;
}

const MIN_SURVIVING_VALUE = 6;

// Only shapes that are self-evident in a serialized payload can be re-checked.
// Covers credentials, all mandatory high-risk personal data rules (RRN, ARN, BRN, Card, Account, Phone),
// and any raw value this session already pseudonymized.
const PERSONAL_WIRE_RULES = new Set([
  'korean_rrn', 'korean_arn', 'korean_brn', 'credit_card_luhn', 'account_digit_run', 'phone_number', 'email_address'
]);

/**
 * Step 6. The masked body is serialized exactly as the provider would receive it
 * and scanned again. A secret, a personal identifier or any raw value this
 * session already pseudonymized must not appear — if one does, the request is
 * refused rather than sent with a known leak.
 */
export function recheckSerialized(serialized, vault, requestValues = null, maskedTexts = null) {
  const text = typeof serialized === 'string' ? serialized : String(serialized ?? '');
  const problems = [];
  for (const finding of detectAll(text)) {
    if (finding.class === 'credential') problems.push({ rule: finding.rule, kind: 'credential', at: finding.start });
    else if (PERSONAL_WIRE_RULES.has(finding.rule) && finding.score >= 0.8) {
      problems.push({ rule: finding.rule, kind: 'personal', at: finding.start });
    }
  }
  // Only the values this request pseudonymized are re-checked. A value the vault
  // holds from an earlier turn — `CONFIDENTIAL` lexed out of another file, say —
  // legitimately appears in this payload and is not a leak of *this* request's
  // pseudonym. Checking the whole session vault blocked ordinary file reads.
  const values = requestValues ?? (vault.originals ? vault.originals() : []);
  // The value check runs on the masked strings themselves, not on their JSON
  // form: escaping changes where a shield (a regex source, a UUID, a data URL)
  // begins and ends, and a shield that is correct for the text the masker saw
  // must be the shield used to decide "this occurrence was deliberately kept".
  const haystacks = Array.isArray(maskedTexts) && maskedTexts.length > 0 ? maskedTexts : [text];
  const shieldsByHaystack = haystacks.map((haystack) => ({ haystack, shields: shieldRanges(haystack) }));
  for (const original of values) {
    if (original.length < MIN_SURVIVING_VALUE) continue;
    let leaked = false;
    for (const { haystack, shields } of shieldsByHaystack) {
      let index = haystack.indexOf(original);
      while (index !== -1) {
        if (!shielded(shields, index, index + original.length)) { leaked = true; break; }
        index = haystack.indexOf(original, index + 1);
      }
      if (leaked) break;
    }
    if (leaked) problems.push({ rule: 'surviving_pseudonym_value', kind: 'vault' });
  }
  return { ok: problems.length === 0, problems };
}

function summarize(findings, extra = {}) {
  const rules = [...new Set(findings.map((finding) => finding.rule))].sort();
  const counts = {};
  for (const finding of findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
  const fields = [...new Set(findings.map((finding) => finding.path).filter(Boolean))].sort();
  const classes = [...new Set(findings.map((finding) => finding.class))].sort();
  return { rules, counts, fields, classes, total: findings.length, ...extra };
}

/**
 * Decide, mask and re-verify one outbound request.
 *
 * @param {{body:object, sessionId?:string|null, route?:string, purpose?:string}} input
 * @returns {Promise<{action:'sent'|'blocked', status:number, code:string|null, reason:string|null,
 *   body:object, report:object, sessionId:string|null} | {action:'send'} >}
 */
export async function screenOutbound({ body = {}, sessionId = null, route = 'local_only', purpose = 'chat', privacyState = 'mask', allowStages = true, slmVerifier = null } = {}) {
  const startedAt = performance.now();
  const vault = getVault(sessionId);
  const findings = scanEnvelope(body, { route });

  // On 'strict' privacyState, any sensitive finding (personal, credential, project) blocks outright
  if (privacyState === 'strict' && findings.length > 0) {
    const report = summarize(findings, {
      sessionId,
      code: PRIVACY_CODES.blocked,
      reason: 'privacy_state_strict_blocks_all_pii',
      fingerprint: vault.fingerprint('strict-block', ...findings.map((f) => f.rule)),
      latencyMs: performance.now() - startedAt,
    });
    privacyEvent('privacy.blocked', report);
    return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.blocked, reason: 'strict_mode_refusal', body, report, sessionId };
  }

  const confirmedSecrets = findings.filter((finding) => finding.class === 'credential'
    && finding.mandatory
    && finding.score >= AMBIGUOUS_HIGH);
  if (confirmedSecrets.length > 0) {
    const report = summarize(confirmedSecrets, {
      sessionId,
      code: PRIVACY_CODES.blocked,
      reason: 'confirmed_secret',
      fingerprint: vault.fingerprint('block', ...confirmedSecrets.map((finding) => finding.rule)),
      latencyMs: performance.now() - startedAt,
    });
    privacyEvent('privacy.blocked', report);
    return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.blocked, reason: 'confirmed_secret', body, report, sessionId };
  }

  const attachments = attachmentProblems(body, route);
  if (attachments.length > 0) {
    const report = summarize([], {
      sessionId,
      code: PRIVACY_CODES.blocked,
      reason: 'attachment_unscannable',
      paths: attachments,
      fingerprint: vault.fingerprint('block', ...attachments.map((problem) => problem.kind)),
      latencyMs: performance.now() - startedAt,
    });
    privacyEvent('privacy.blocked', report);
    return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.blocked, reason: 'attachment_unscannable', body, report, sessionId };
  }

  // Fail closed: an ambiguous high-risk span in a national-ID or credential
  // context cannot be verified without the stage-3 model, and "probably fine"
  // is not an acceptable verdict for a resident registration number.
  const highRisk = findings.filter((finding) => isAmbiguous(finding.score) && finding.risk === 'high');
  if (highRisk.length > 0 && allowStages) {
    const { unverifiable, stage } = await verifyHighRisk(findings, {
      deadlineMs: probeSlm().deadlineMs,
      verify: slmVerifier,
    });
    if (unverifiable.length > 0) {
      const report = summarize(unverifiable, {
        sessionId,
        code: PRIVACY_CODES.unverifiable,
        reason: stage?.status?.reason ?? 'slm_unavailable',
        fingerprint: vault.fingerprint('unverifiable', ...unverifiable.map((finding) => finding.rule)),
        latencyMs: performance.now() - startedAt,
      });
      privacyEvent('privacy.blocked', report);
      return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.unverifiable, reason: 'unverifiable_high_risk', body, report, sessionId };
    }
  } else if (highRisk.length > 0) {
    const report = summarize(highRisk, {
      sessionId,
      code: PRIVACY_CODES.unverifiable,
      reason: 'stages_disabled',
      fingerprint: vault.fingerprint('unverifiable', ...highRisk.map((finding) => finding.rule)),
      latencyMs: performance.now() - startedAt,
    });
    privacyEvent('privacy.blocked', report);
    return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.unverifiable, reason: 'unverifiable_high_risk', body, report, sessionId };
  }

  const hits = [];
  const valuesBefore = vault.entries().length;
  const maskedTexts = [];
  const maskedBody = mapEnvelope(body, (text, meta) => {
    // The key is context: a value under `address`/`계좌번호` is an address/account
    // number even when the surrounding prose never says so. Detection reads the raw
    // key (`detectionHint`); only the sanitized `path` is ever published.
    const masked = maskString(text, vault, { kind: meta.kind, hint: meta.detectionHint ?? meta.path });
    for (const hit of masked.hits) hits.push({ ...hit, path: meta.path });
    maskedTexts.push(masked.text);
    return masked.text;
  });
  // Values allocated for *this* payload are the ones whose absence proves the
  // masking worked; earlier turns' pseudonyms are out of scope.
  const requestValues = vault.entries().slice(valuesBefore).map((entry) => entry.value);

  const serialized = JSON.stringify(maskedBody);
  const recheck = recheckSerialized(serialized, vault, requestValues, maskedTexts);
  if (!recheck.ok) {
    const report = summarize(findings, {
      sessionId,
      code: PRIVACY_CODES.recheck,
      reason: 'wire_payload_contains_protected_value',
      problems: recheck.problems.map((problem) => problem.rule),
      fingerprint: vault.fingerprint('recheck', ...recheck.problems.map((problem) => problem.rule)),
      latencyMs: performance.now() - startedAt,
    });
    privacyEvent('privacy.blocked', report);
    return { action: 'blocked', status: PRIVACY_STATUS.blocked, code: PRIVACY_CODES.recheck, reason: 'recheck_failed', body: maskedBody, report, sessionId };
  }

  const report = summarize(hits, {
    sessionId,
    code: null,
    reason: null,
    purpose,
    route,
    fingerprint: vault.fingerprint('masked', ...hits.map((hit) => hit.rule), ...hits.map((hit) => hit.path)),
    latencyMs: performance.now() - startedAt,
    scanned: findings.length,
  });
  if (hits.length > 0) privacyEvent('privacy.masked', report);
  return { action: 'sent', status: 200, code: null, reason: null, body: maskedBody, report, sessionId, vault };
}

// Which request a decision belongs to. A timestamp watermark cannot answer that:
// any `privacy.*` record appended for the session during the request window was
// claimed by the request being answered, so an out-of-band `/api/privacy/scan` on
// the same session id made a clean chat advertise a mask it never performed. The
// correlation is minted per outbound request and carried on the record itself, so
// a consumer matches records to the request that caused them rather than to a time
// window. It is an opaque UUID: nothing about the payload.
const correlationStore = new AsyncLocalStorage();

/** Run `fn` with `correlation` attached to every privacy record it causes. */
export function runWithPrivacyCorrelation(correlation, fn) {
  return correlationStore.run(typeof correlation === 'string' && correlation ? correlation : null, fn);
}

/** The correlation of the request currently being screened, if any. */
export function privacyCorrelation() {
  return correlationStore.getStore() ?? null;
}

/** Emit a privacy event. Only ids, counts, paths and the fingerprint go out. */
export function privacyEvent(type, report) {
  const fields = {
    session: report.sessionId ?? null,
    data: {
      rules: report.rules ?? [],
      counts: report.counts ?? {},
      fields: report.fields ?? [],
      classes: report.classes ?? [],
      total: report.total ?? 0,
      fingerprint: report.fingerprint ?? null,
      code: report.code ?? null,
      reason: report.reason ?? null,
      correlation: privacyCorrelation(),
      latencyMs: Number.isFinite(report.latencyMs) ? Math.round(report.latencyMs * 1000) / 1000 : null,
    },
  };
  try {
    return emitEvent(type, fields);
  } catch {
    // Telemetry must never fail the decision it describes.
    return null;
  }
}

/**
 * Deterministic log redaction: the same text always redacts the same way, and a
 * credential is removed outright rather than replaced by a pseudonym.
 */
export function redactForLog(text) {
  const source = String(text ?? '');
  if (!source) return source;
  const vault = createVault(null);
  const masked = maskString(source, vault, { kind: 'text' });
  let out = masked.text;
  const credentialHits = masked.hits.filter((hit) => hit.class === 'credential');
  const seen = new Set();
  for (const hit of credentialHits) {
    if (seen.has(hit.placeholder)) continue;
    seen.add(hit.placeholder);
    out = out.split(hit.placeholder).join(`[REDACTED:${hit.rule}]`);
  }
  return out;
}

export { AMBIGUOUS_HIGH, AMBIGUOUS_LOW, restoreString };
