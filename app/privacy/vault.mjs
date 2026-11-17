// The pseudonym vault.
//
// One vault per conversation, held for the life of the session. The old
// `createPiiMaskContext` reset its counter on every request, so the same phone
// number got `PHONE_1` in turn one and `PHONE_1` again in turn two but for a
// different value — the model could not tell two people apart, and reusing an
// index across turns silently merged them. The counter and the value index now
// belong to the session, so `+82-10-1234-5678` and `010-1234-5678` are the same
// person on every turn.
//
// Two spellings of the same pseudonym exist because the same PII can appear in
// prose and in code:
//   * prose / string literal:  `[PERSON_1]`
//   * unquoted code position:  `__PII_PERSON_1__`
// The second form is a legal JS/TS identifier, so masked code still parses and
// compiles; masking a variable name with `[PERSON_1]` would produce a syntax error.

import { createHmac, randomBytes } from 'node:crypto';

const ZWSP = '\u200b';
const MAX_ENTRIES = 4000;

/** Category label per rule id. This is what the user and the model see. */
export const CATEGORY_OF_RULE = Object.freeze({
  korean_name: 'PERSON',
  phone_number: 'PHONE',
  email_address: 'EMAIL',
  korean_rrn: 'RRN',
  korean_arn: 'RRN',
  korean_brn: 'BRN',
  credit_card_luhn: 'CARD',
  account_digit_run: 'ACCOUNT',
  korean_address: 'ADDRESS',
  ipv4_address: 'IP',
  private_key_pem: 'SECRET',
  private_key_openssh: 'SECRET',
  provider_key: 'SECRET',
  jwt_token: 'SECRET',
  auth_header: 'SECRET',
  db_uri: 'SECRET',
  generic_secret: 'SECRET',
  private_network_ip: 'HOST',
  internal_hostname: 'HOST',
  env_file_body: 'SECRET',
  confidential_marker: 'PROJECT',
});

const RULE_LABELS = Object.freeze({
  korean_name: '이름',
  phone_number: '전화번호',
  email_address: '이메일',
  korean_rrn: '주민등록번호',
  korean_arn: '외국인등록번호',
  korean_brn: '사업자등록번호',
  credit_card_luhn: '카드번호',
  account_digit_run: '계좌번호',
  korean_address: '주소',
  ipv4_address: 'IP 주소',
  private_key_pem: '개인키',
  private_key_openssh: '개인키',
  provider_key: 'API 키',
  jwt_token: 'JWT',
  auth_header: '인증 헤더',
  db_uri: 'DB 연결 문자열',
  generic_secret: '비밀 값',
  private_network_ip: '내부 IP',
  internal_hostname: '내부 호스트',
  env_file_body: '.env 본문',
  confidential_marker: '기밀 표식',
});

export function categoryForRule(rule) {
  return CATEGORY_OF_RULE[rule] ?? 'PII';
}

export function labelForRule(rule) {
  return RULE_LABELS[rule] ?? rule;
}

/** Canonical form of a matched value, so equivalent spellings share one index. */
export function normalizeValue(rule, value) {
  const text = String(value ?? '').trim();
  switch (rule) {
    case 'phone_number': {
      let digits = text.replace(/[^\d+]/g, '');
      if (digits.startsWith('+82')) digits = `0${digits.slice(3)}`;
      else if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
      return `phone:${digits.replace(/^\+/, '')}`;
    }
    case 'email_address':
      return `email:${text.toLowerCase()}`;
    case 'credit_card_luhn':
      return `card:${text.replace(/\D/g, '')}`;
    case 'korean_rrn':
    case 'korean_arn':
      return `rrn:${text.replace(/\D/g, '')}`;
    case 'korean_brn':
      return `brn:${text.replace(/\D/g, '')}`;
    case 'account_digit_run':
      return `account:${text.replace(/[^\d]/g, '')}`;
    case 'korean_name':
      return `name:${text.replace(/\s+/g, '')}`;
    case 'korean_address':
      return `address:${text.replace(/\s+/g, ' ')}`;
    case 'ipv4_address':
    case 'private_network_ip':
      return `ip:${text}`;
    case 'internal_hostname':
      return `host:${text.toLowerCase()}`;
    default:
      return `${rule}:${text}`;
  }
}

/** Pre-existing pseudo placeholders in user input are literal text, not ours. */
const LITERAL_BRACKET = /\[([A-Z]{3,8}_\d+)\]/g;

/** Break the bracket form so it can never be mistaken for one of our pseudonyms. */
export function escapeLiteralPseudonyms(text) {
  return String(text ?? '').replace(LITERAL_BRACKET, (_match, inner) => `[${ZWSP}${inner}${ZWSP}]`);
}

/** Undo the escape. Round-trip is exact: the zero-width spaces are not data. */
export function unescapeLiteralPseudonyms(text) {
  const source = String(text ?? '');
  return source.includes(ZWSP) ? source.split(ZWSP).join('') : source;
}

export function createVault(sessionId = null, resumeCounters = null) {
  const byKey = new Map(); // canonical value -> entry
  const counters = new Map(); // category -> last index
  // A resumed vault keeps counting where the evicted one stopped, so a token is
  // never handed to a second entity inside one conversation.
  for (const [category, index] of Object.entries(resumeCounters ?? {})) {
    if (Number.isFinite(index)) counters.set(category, index);
  }
  const mapping = new Map(); // placeholder -> original (both spellings)
  const counts = Object.create(null); // rule -> allocation count
  const fingerprintKey = randomBytes(32);
  let session = sessionId ?? null;

  function allocate(rule, rawValue, { form = 'code', reserve = null } = {}) {
    const value = String(rawValue ?? '');
    const key = normalizeValue(rule, value);
    let entry = byKey.get(key);
    if (!entry) {
      const category = categoryForRule(rule);
      let index = (counters.get(category) ?? 0) + 1;
      // If the input string already contains `[CAT_N]` or `__PII_CAT_N__` as literal text,
      // skip that index so our pseudonym never collides with user text on restore.
      while (reserve && (reserve.includes(`[${category}_${index}]`) || reserve.includes(`__PII_${category}_${index}__`))) {
        index += 1;
      }
      counters.set(category, index);
      entry = { key, rule, category, index, value, prose: `[${category}_${index}]`, code: `__PII_${category}_${index}__` };
      if (byKey.size >= MAX_ENTRIES) {
        const oldest = byKey.keys().next().value;
        const dropped = byKey.get(oldest);
        byKey.delete(oldest);
        if (dropped) { mapping.delete(dropped.prose); mapping.delete(dropped.code); }
      }
      byKey.set(key, entry);
      mapping.set(entry.prose, entry.value);
      mapping.set(entry.code, entry.value);
    }
    counts[rule] = (counts[rule] ?? 0) + 1;
    return form === 'prose' ? entry.prose : entry.code;
  }

  return {
    get sessionId() { return session; },
    setSessionId(next) { session = next ?? null; },
    mapping,
    counts,
    byKey,
    /** category -> last index handed out; read when a vault is evicted and resumed. */
    counters,
    /** @param {{form?:'prose'|'code'}} options */
    allocate,
    /** Back-compat: the long (`__PII_...__`) spelling. */
    allocatePlaceholder(rule, original) { return allocate(rule, original, { form: 'code' }); },
    lookup(rule, rawValue) { return byKey.get(normalizeValue(rule, rawValue)) ?? null; },
    entries() { return [...byKey.values()]; },
    originals() { return [...byKey.values()].map((entry) => entry.value); },
    /** 8-hex, keyed per session: stable within a conversation, useless outside it. */
    fingerprint(...parts) {
      return createHmac('sha256', fingerprintKey).update(parts.join('|')).digest('hex').slice(0, 8);
    },
    get size() { return mapping.size; },
    get valueCount() { return byKey.size; },
    clear() {
      mapping.clear();
      byKey.clear();
      counters.clear();
      for (const key of Object.keys(counts)) delete counts[key];
    },
  };
}

const VAULTS = new Map();
// The counters of a vault the map has dropped. Without this, a conversation that
// comes back after its vault was evicted starts again at index 1 and hands
// `[PHONE_1]` to a second person while the transcript still holds `[PHONE_1]` for
// the first: the assistant's earlier reply then restores to the wrong number, and
// two distinct entities share one pseudonym. Keeping the last index per category
// per conversation makes an index unique for the life of the conversation, not the
// life of the cache entry.
const RETIRED = new Map();
const MAX_RETIRED = 4096;

function retireCounters(sessionId, counters) {
  if (!sessionId || counters.size === 0) return;
  RETIRED.set(sessionId, Object.fromEntries(counters));
  while (RETIRED.size > MAX_RETIRED) RETIRED.delete(RETIRED.keys().next().value);
}

/**
 * The session's vault, created on first use and kept for the session's life.
 * `null`/`''` yields a fresh one-shot vault (documents and logs stay deterministic).
 */
export function getVault(sessionId = null) {
  if (!sessionId) return createVault(null);
  let vault = VAULTS.get(sessionId);
  if (!vault) {
    vault = createVault(sessionId, RETIRED.get(sessionId) ?? null);
    VAULTS.set(sessionId, vault);
    if (VAULTS.size > 64) {
      const oldest = VAULTS.keys().next().value;
      const dropped = VAULTS.get(oldest);
      if (dropped) retireCounters(oldest, dropped.counters);
      VAULTS.delete(oldest);
    }
  }
  return vault;
}

export function releaseVault(sessionId) {
  const vault = VAULTS.get(sessionId);
  if (vault) retireCounters(sessionId, vault.counters);
  return VAULTS.delete(sessionId);
}

export function resetVaults() {
  VAULTS.clear();
  RETIRED.clear();
}
export const LITERAL_ESCAPE_MARK = ZWSP;
