// The detector catalogue: three data classes, one catalogue.
//
// Every detector answers three questions — what class it is, how sure the
// evidence is (mandatory rule vs. context-gated candidate), and where the span
// is. Nothing here calls a model. The optional SLM stage (slm.mjs) may only
// promote an *ambiguous* candidate; it can never downgrade a mandatory rule.

import { entropyBits, tokenEfficiency } from './tokenizer.mjs';
import { overlapsShield, shieldRanges } from './shield.mjs';

export const RULE_RRN = 'korean_rrn';
export const RULE_ARN = 'korean_arn';
export const RULE_BRN = 'korean_brn';
export const RULE_CARD = 'credit_card_luhn';
export const RULE_EMAIL = 'email_address';
export const RULE_IPV4 = 'ipv4_address';
export const RULE_PHONE = 'phone_number';
export const RULE_ACCOUNT = 'account_digit_run';
export const RULE_NAME = 'korean_name';
export const RULE_ADDRESS = 'korean_address';
export const RULE_PRIVATE_KEY = 'private_key_pem';
export const RULE_OPENSSH_KEY = 'private_key_openssh';
export const RULE_PROVIDER_KEY = 'provider_key';
export const RULE_JWT = 'jwt_token';
export const RULE_AUTH_HEADER = 'auth_header';
export const RULE_DB_URI = 'db_uri';
export const RULE_GENERIC_SECRET = 'generic_secret';
export const RULE_PRIVATE_IP = 'private_network_ip';
export const RULE_INTERNAL_HOST = 'internal_hostname';
export const RULE_ENV_BODY = 'env_file_body';
export const RULE_CONFIDENTIAL = 'confidential_marker';

export const DATA_CLASSES = Object.freeze(['personal', 'credential', 'project']);

export const RULE_META = Object.freeze({
  [RULE_RRN]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_ARN]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_BRN]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_CARD]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_EMAIL]: { class: 'personal', risk: 'medium', mandatory: true, score: 1 },
  [RULE_IPV4]: { class: 'project', risk: 'medium', mandatory: true, score: 1 },
  [RULE_PHONE]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_ACCOUNT]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_NAME]: { class: 'personal', risk: 'medium', mandatory: true, score: 0.86 },
  [RULE_ADDRESS]: { class: 'personal', risk: 'high', mandatory: true, score: 1 },
  [RULE_PRIVATE_KEY]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_OPENSSH_KEY]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_PROVIDER_KEY]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_JWT]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_AUTH_HEADER]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_DB_URI]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_GENERIC_SECRET]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_PRIVATE_IP]: { class: 'project', risk: 'medium', mandatory: true, score: 1 },
  [RULE_INTERNAL_HOST]: { class: 'project', risk: 'medium', mandatory: true, score: 1 },
  [RULE_ENV_BODY]: { class: 'credential', risk: 'high', mandatory: true, score: 1 },
  [RULE_CONFIDENTIAL]: { class: 'project', risk: 'medium', mandatory: true, score: 0.9 },
});

// A span is only "ambiguous" when a context-gated detector is unsure. Those live
// in the [0.45, 0.80) band and are the only spans the SLM stage may touch.
export const AMBIGUOUS_LOW = 0.45;
export const AMBIGUOUS_HIGH = 0.8;

const PRIORITY = [
  RULE_OPENSSH_KEY, RULE_PRIVATE_KEY, RULE_PROVIDER_KEY, RULE_AUTH_HEADER, RULE_JWT,
  RULE_DB_URI, RULE_ENV_BODY, RULE_GENERIC_SECRET,
  RULE_RRN, RULE_ARN, RULE_BRN, RULE_CARD, RULE_ACCOUNT, RULE_PHONE, RULE_EMAIL,
  RULE_IPV4, RULE_ADDRESS, RULE_NAME, RULE_PRIVATE_IP, RULE_INTERNAL_HOST, RULE_CONFIDENTIAL,
];

const CLASS_OF = Object.fromEntries(PRIORITY.map((rule) => [rule, RULE_META[rule].class]));
const RISK_OF = Object.fromEntries(PRIORITY.map((rule) => [rule, RULE_META[rule].risk]));
const MANDATORY_OF = Object.fromEntries(PRIORITY.map((rule) => [rule, RULE_META[rule].mandatory]));
const BASE_SCORE = Object.fromEntries(PRIORITY.map((rule) => [rule, RULE_META[rule].score]));

export function isMandatory(rule) {
  return MANDATORY_OF[rule] === true;
}

export function ruleClass(rule) {
  return CLASS_OF[rule] ?? 'personal';
}

// ── validators ───────────────────────────────────────────────────────────────

export function validateLuhn(digits) {
  const clean = String(digits).replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = clean.length - 1; index >= 0; index -= 1) {
    let digit = Number.parseInt(clean.charAt(index), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** Which card network a Luhn-valid number claims to be, or null. */
export function cardNetwork(digits) {
  const clean = String(digits).replace(/\D/g, '');
  const length = clean.length;
  const p2 = Number(clean.slice(0, 2));
  const p3 = Number(clean.slice(0, 3));
  const p4 = Number(clean.slice(0, 4));
  if (clean.startsWith('4') && [13, 16, 19].includes(length)) return 'visa';
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2222 && p4 <= 2725)) && length === 16) return 'mastercard';
  if ((clean.startsWith('34') || clean.startsWith('37')) && length === 15) return 'amex';
  if (((p3 >= 300 && p3 <= 305) || clean.startsWith('36')) && [14, 16].includes(length)) return 'diners';
  if (p4 >= 3528 && p4 <= 3589 && length === 16) return 'jcb';
  if (p3 >= 620 && p3 <= 699 && [16, 17, 18, 19].includes(length)) return 'unionpay';
  if ((clean.startsWith('6011') || clean.startsWith('65')) && [16, 17, 18, 19].includes(length)) return 'discover';
  return null;
}

/** Pre-October-2020 RRN: 13 digits with the mod-11 check digit. */
export function validateKoreanRRN(digits) {
  const clean = String(digits).replace(/\D/g, '');
  if (clean.length !== 13) return false;
  const month = Number.parseInt(clean.slice(2, 4), 10);
  const day = Number.parseInt(clean.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const genderDigit = Number.parseInt(clean.charAt(6), 10);
  if (genderDigit < 1 || genderDigit > 8) return false;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number.parseInt(clean.charAt(index), 10) * weights[index];
  return (11 - (sum % 11)) % 10 === Number.parseInt(clean.charAt(12), 10);
}

/**
 * Post-October-2020 RRN: the last six digits are random, so the check digit no
 * longer exists. Only the structure is left — a real date, a gender digit in
 * 5–8 — which is why this rule requires surrounding context to fire.
 */
export function validatePost2020RRN(digits) {
  const clean = String(digits).replace(/\D/g, '');
  if (clean.length !== 13) return false;
  const month = Number.parseInt(clean.slice(2, 4), 10);
  const day = Number.parseInt(clean.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (!/^[0-9]{2}$/.test(clean.slice(0, 2))) return false;
  const genderDigit = Number.parseInt(clean.charAt(6), 10);
  return genderDigit >= 5 && genderDigit <= 8;
}

export function validateIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number.parseInt(part, 10);
    if (num < 0 || num > 255) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
  }
  return true;
}

/** Korean Business Registration Number: 10 digits with its weighted check digit. */
export function validateBRN(text) {
  const clean = String(text).replace(/\D/g, '');
  if (clean.length !== 10) return false;
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number.parseInt(clean.charAt(index), 10) * weights[index];
  return (10 - (sum % 10)) % 10 === Number.parseInt(clean.charAt(9), 10);
}

const RFC2606_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'test', 'localhost', 'invalid', 'example']);
const RFC2606_TLDS = new Set(['example', 'test', 'invalid', 'localhost', 'local']);

// An `@` between two identifiers is also a URI authority and an scp-style remote:
// `ssh://deploy@host.acme.io/repo`, `https://user@github.com/acme/app.git` and
// `git@github.com:acme/app.git` all parse as `local@domain`. Masking those produced
// `[EMAIL_1]:acme/app.git` and `ssh://[EMAIL_1]/repo` — a remote that no longer
// resolves, and no mailbox protected. A URI authority that carries a `user:secret`
// is NOT exempt: that secret is a credential, and it is the one thing the shape can
// legitimately contain.
const URI_AUTHORITY_BEFORE = /([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/]*)$/;
const SCP_REMOTE_AFTER = /^:[^\s:/\\]+\/[^\s:]*/;

function isAddressNotMailbox(source, start, end) {
  const before = source.slice(Math.max(0, start - 120), start);
  const scheme = URI_AUTHORITY_BEFORE.exec(before);
  if (scheme) return !scheme[2].includes(':');
  const at = source.indexOf('@', start);
  if (at < 0 || at >= end) return false;
  const local = source.slice(start, at);
  if (!/^[a-z][a-z0-9._-]*$/.test(local)) return false;
  return SCP_REMOTE_AFTER.test(source.slice(end));
}

function isPlaceholderEmail(local, domain) {
  const host = domain.toLowerCase();
  if (RFC2606_DOMAINS.has(host)) return true;
  for (const reserved of RFC2606_DOMAINS) {
    if (host.endsWith(`.${reserved}`)) return true;
  }
  const tld = host.split('.').pop();
  if (RFC2606_TLDS.has(tld)) return true;
  if (/^[a-z]+\.[a-z]{2}$/.test(host) && host.includes('example')) return true;
  // Documentation spellings: `you@your-domain`, `name@host`
  if (!host.includes('.')) return true;
  if (/^(?:user|you|someone|name|email|test|foo|bar|user1)@/.test(local) && RFC2606_DOMAINS.has(host)) return true;
  return false;
}

const VENDOR_EXAMPLE_PATTERNS = [
  /^AKIAIOSFODNN7EXAMPLE$/,
  /^ASIAIOSFODNN7EXAMPLE$/,
  /^wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY$/,
];

// ── key-block structure ──────────────────────────────────────────────────────
//
// A real PEM/OpenSSH block carries a base64 body between its BEGIN and END lines.
// A detector's own regex source, a documentation placeholder or a test skeleton
// carries regex metacharacters (`[\s\S]*?`, `(?:`, `|`) in that position instead.
// Requiring a base64 body is a property of the format, not an allow-list of files.

const BASE64_BODY = /^[A-Za-z0-9+/=:\s]{6,}$/;

/** True when the text between the BEGIN and END lines is a key body, not a pattern. */
export function hasKeyBody(block) {
  const text = String(block ?? '');
  const begin = text.indexOf('-----');
  const afterBegin = text.indexOf('-----', begin + 5);
  if (begin < 0 || afterBegin < 0) return false;
  const end = text.indexOf('-----END');
  if (end <= afterBegin) return false;
  const body = text.slice(afterBegin + 5, end).trim();
  // Six characters is already enough to tell a body from an expression: a
  // pattern such as `[\s\S]*?` carries `[`, `]`, `*` and `?`, none of which are
  // base64, so it fails here while a short test key block passes.
  if (body.length < 6) return false;
  return BASE64_BODY.test(body);
}

/**
 * `<…>` marks a template only when the text inside is not a credential in its own
 * right: `<your_token_here>` is documentation, `<Sup3rS3cret!x>` is a password
 * someone wrapped in angle brackets. Both the vendor-example check and
 * `isPlaceholderValue` ask this question, so they answer it the same way.
 */
function isPlaceholderBrackets(inner) {
  const text = String(inner ?? '').trim();
  if (!text) return true;
  return !(looksTypedSecret(text) || looksOpaque(text));
}

/**
 * A `[...]` template says so in words: `[YOUR_KEY_HERE]`, `[redacted]`,
 * `[insert token]`. Brackets are also punctuation a password can carry —
 * `Kq7[Rt2]Xz9` — so the content decides, not the brackets.
 */
function isDocumentationBrackets(inner) {
  const text = String(inner ?? '').trim();
  if (!text) return true;
  if (/\s/.test(text)) return true;
  if (/^(?:redacted|hidden|elided|omitted|masked)$/i.test(text)) return true;
  // A placeholder word anywhere inside (`[YOUR_KEY_HERE]`, `[insert token]`), or a
  // documentation convention: an all-caps inner of underscore/noun words
  // (`[API_KEY]`). A single capitalised word (`[Secret]`) is a password in
  // brackets, not a template, and `Kq7[Rt2]Xz9` carries a digit-bearing token.
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.some((word) => PLACEHOLDER_WORDS.has(word.toLowerCase()))) return true;
  return /^[A-Z0-9_]+$/.test(text) && words.every((word) => PLACEHOLDER_NOUNS.has(word.toLowerCase().replace(/\d+$/, '')));
}

/**
 * Remove the bracketed spans that are documentation and keep every other
 * character. A documentation bracket speaks for itself — `[your_key]` is a
 * template — and says nothing about whatever a human wrote around it, so the
 * text left after removing it is what the value checks have to judge.
 *
 * The inner text is bounded. An unbounded `[^\]]*` with no closing `]` in sight
 * rescanned to the end of the line from every `[`, so a prompt line of 8 000
 * unbalanced brackets cost seconds inside one value check — and a value check runs
 * several times per shape. Two hundred characters is far more than a placeholder
 * or a bracketed password needs, and it makes the walk linear.
 */
function withoutDocumentationBrackets(value) {
  return String(value ?? '')
    .replace(/<([^>\n]{0,200})>/g, (whole, inner) => (isPlaceholderBrackets(inner) ? '' : whole))
    .replace(/\[([^\]\n]{0,200})\]/g, (whole, inner) => (isDocumentationBrackets(inner) ? '' : whole));
}

/** A secret whose body is obviously a placeholder is a documentation example. */
function isVendorExample(value) {
  const body = String(value);
  // Judge the value without its documentation brackets: `[your_key]Kq7Rt2Xz9` is a
  // key someone wrote after a template, not a template.
  const bare = withoutDocumentationBrackets(body);
  if (bare !== body && !bare.trim()) return true;
  if (VENDOR_EXAMPLE_PATTERNS.some((pattern) => pattern.test(bare))) return true;
  // `example` is documentation as a whole segment, not as a prefix: `/EXAMPLE/i`
  // anywhere exempted `exampleS3cret99`, a placeholder word glued to a password.
  if (/(?:^|[._\-\s:])examples?(?:[._\-\s:]|$)/i.test(bare)) return true;
  if (/EXAMPLE[A-Z]*$/.test(bare)) return true;
  // `<...>` and `${...}` are documentation only when the text inside them is not
  // a secret in its own right. Treating any angle bracket as documentation let
  // `DB_PASS=<Sup3rS3cret!x>` through on every path, body included.
  // `[...]` is documentation only when its content says so — `[YOUR_KEY_HERE]`,
  // `[redacted]`, `[your_key_here]`. Exempting any bracketed value sent
  // `DB_PASS=Kq7[Rt2]Xz9` and `DB_PASS=Sup3r[Secret]99`: brackets are punctuation
  // a password can carry, so the content has to be documentation, not the brackets.
  // What is left of `bare` after the documentation spans are gone is the part a
  // human wrote: an angle bracket or a square bracket here is a password's own
  // punctuation, and the documentation spans are already removed.
  if (/\bxxxx+|\bx{8,}|\$\{[^}]*\}/i.test(bare)) return true;
  if (/<[^>\n]{0,200}>|\[[^\]\n]{0,200}\]/.test(bare)) return false;
  const core = bare.replace(/^(?:sk-proj-|sk-ant-|sk-|AKIA|ASIA|gh[pousr]_|github_pat_|AIza|xox[baprs]-|glpat-|hf_)/, '');
  if (core.length > 0 && /^(?:[xz*._-])+$/i.test(core)) return true;
  return false;
}

const PROVIDER_KEY_PATTERNS = [
  { vendor: 'openai', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { vendor: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { vendor: 'openai', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { vendor: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { vendor: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { vendor: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { vendor: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { vendor: 'slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { vendor: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { vendor: 'huggingface', re: /\bhf_[A-Za-z0-9]{20,}/g },
];

const SECRET_WORDS = new Set([
  'APIKEY', 'SECRET', 'TOKEN', 'PASS', 'PASSWORD', 'PASSWD', 'PWD', 'AUTH',
  'CREDENTIAL', 'CREDENTIALS', 'CREDS', 'PRIVATE', 'PRIVKEY',
]);

// `key` alone names any JSON key, a sort key, a cache key or a React prop — it is
// not a credential. What makes a `…_key` a credential is the word in front of it,
// so only these qualifiers turn a bare `key` into a secret-bearing name.
const KEY_QUALIFIERS = new Set([
  'API', 'SECRET', 'PRIVATE', 'ACCESS', 'AUTH', 'MASTER', 'SIGNING', 'ENCRYPTION',
  'CLIENT', 'LICENSE', 'PROVIDER', 'SERVICE', 'DEPLOY', 'ENCRYPT', 'SIGNATURE',
  'WRITE', 'READ', 'ADMIN', 'ROOT',
]);

// The credential words that leave no room for a "too short to be a secret" reading
// of their value. `PASS` and `AUTH` are deliberately absent: `PASS=info:debug` and
// `AUTH=basic:digest` name a mode, so their values keep the shape checks.
const UNAMBIGUOUS_CREDENTIAL = new Set([
  'PASSWORD', 'PASSWD', 'PWD', 'SECRET', 'SECRETS', 'APIKEY', 'TOKEN',
  'PRIVATE', 'PRIVKEY', 'CREDENTIAL', 'CREDENTIALS', 'CREDS',
]);
const TOKEN_QUALIFIERS = new Set([
  'ACCESS', 'REFRESH', 'AUTH', 'BEARER', 'API', 'ID', 'SESSION', 'CSRF', 'OAUTH',
  'SECRET', 'PERSONAL', 'BOT', 'DB',
]);

// A value that names another variable instead of carrying a literal is never a
// secret: `process.env.DB_PASSWORD`, `os.environ['API_KEY']`, `os.getenv('X')`,
// `${VAR}`, a pyformat placeholder (`%(db_password)s`) and an ALL_CAPS variable
// name are all references. The name check needs an underscore or an all-capital
// name, so a password that starts with `$` and is not spelled like a variable
// (`$ecret99`, `$hunter2x`) is still a password.
const VARIABLE_REFERENCE = [
  /^\$\{[^}\n]*\}$/,
  /^(?:process\.env|os\.environ|os\.getenv|getenv|env|config|settings)\s*(?:\.|\[|\()/,
  // A pyformat placeholder is bound at render time: `%(db_password)s`.
  /^%\([A-Za-z_][A-Za-z0-9_]*\)[sdifr]$/,
];
const VARIABLE_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function isVariableReference(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (VARIABLE_REFERENCE.some((pattern) => pattern.test(text))) return true;
  return VARIABLE_NAME.test(text.startsWith('$') ? text.slice(1) : text);
}

/** Split an LHS into camel/underscore tokens so `cacheKey` is `cache` + `key`. */
export function leftHandTokens(lhs) {
  return String(lhs ?? '')
    .replace(/[.\[\]{}()]/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

export function hasSecretWord(lhs) {
  const tokens = leftHandTokens(lhs);
  if (tokens.some((token) => SECRET_WORDS.has(token))) return true;
  // A `key` is a credential only when the word in front of it says so: `api_key`,
  // `secret_key`, `private_key` and `access_key` qualify, while `key`, `key_env`,
  // `next_key`, `sortKey` and `cacheKey` are ordinary property names. Judging the
  // bare token made every one of them a credential and refused `app/config.json`.
  return tokens.some((token, index) => token === 'KEY' && index > 0 && KEY_QUALIFIERS.has(tokens[index - 1]));
}

/**
 * Is this key one that leaves no room for a "too short to be a secret" reading of
 * its value? Only an unambiguous credential word counts, and a metadata word in
 * the same key (`password_min_length`, `token_count`, `password_policy`) always
 * wins: those values are settings, whatever their width.
 */
export function isUnambiguousCredentialKey(lhs) {
  const tokens = leftHandTokens(lhs);
  if (!tokens.length) return false;
  if (tokens.some((token) => CREDENTIAL_PROPERTY.has(token))) return false;
  if (!hasSecretWord(lhs)) return false;
  const last = tokens[tokens.length - 1];
  // `token` is a credential as the whole key or under a credential qualifier
  // (`access_token`); `kv_per_token`, `on_token` and `CHARS_PER_TOKEN` name a unit.
  if (last === 'TOKEN') return tokens.length === 1 || TOKEN_QUALIFIERS.has(tokens[tokens.length - 2]);
  if (UNAMBIGUOUS_CREDENTIAL.has(last)) return true;
  return last === 'KEY' && tokens.length > 1 && KEY_QUALIFIERS.has(tokens[tokens.length - 2]);
}

const BENIGN_VALUE = [
  /^(?:true|false|null|undefined|none|nil|n\/a)$/i,
  /^(?:[a-z0-9_./-]{0,}?):?(?:[a-z0-9_./-]{0,}?)\.(?:mjs|js|cjs|mts|ts|json|jsonl|css|html|md|yml|yaml|log|txt|png|svg|pdf|toml|ini)$/i,
  /^(?:https?:|git@|npm:|node:|file:)/i,
  /^[*]{2,}$/,
  /^(?:korean_|credit_card_|email_|ipv4_|phone_|account_|private_key_|provider_|jwt_|auth_|db_|generic_|private_network_|internal_|env_|confidential_)/i,
  // `localhost:5432`, `db.internal:3306`: a host and a port, not `user:password`.
  // The old `[A-Za-z0-9_.-]+` right-hand side also matched `admin:pw12345` and
  // exempted a real credential pair on every path.
  /^[A-Za-z0-9_]+:(?:[0-9]{1,5}|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)+)$/,
];

// A dotenv inline comment starts at `#` only when whitespace precedes it, so
// `MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4` is one value. A `[^\s#]` class cut at every `#`
// anywhere, which made the mask cover `Zx9!Kq2@Lm7` and leave `#Pz4` — the rest
// of the same password — on the wire. The lookahead ends the value at the end of
// the line or at a whitespace-preceded comment, never at an attached `#`.
// A quoted value is one token even when it contains spaces — a passphrase is
// written that way — so the value pattern admits a quoted string whole. A bare
// value still ends at whitespace, which is what keeps a sentence after `=` out of
// the rules. The captured value keeps its quotes so the caller can tell the two
// shapes apart; `stripEnvQuotes` removes them before any check.
//
// A bracketed documentation span is one token even when it contains a space: a
// bare `[^\s]+` ended the value at `[note for you]`, so `DB_PASS=[note …]Kq7…`
// reported the template and never saw the key glued to it. A balanced `[...]` is
// therefore admitted whole, and a stray `[` no longer ends the value either.
// A `<` or a `[` that never closes is a character a value carries, not the end of
// the value: `<` is ordinary data here, so `DB_PASS=Sup3r<S3cret!x` is one
// credential instead of no match at all. The old class excluded `<` from the
// single characters and admitted it only inside a balanced `<…>`, so an unbalanced
// one left the pattern with nothing to consume, the whole assignment failed to
// match, and the password was sent unmasked. The bracket bodies are bounded so a
// line of unmatched `[` cannot be rescanned from every position.
const ENV_VALUE_SOURCE = '("[^"\\n]*"|\'[^\'\\n]*\'|(?:[^\\s\\[<]|\\[[^\\]\\n]{0,200}\\]|<[^>\\n]{0,200}>|[\\[<])+)(?=[ \\t]+#|[ \\t]*$)';
const ENV_ASSIGNMENT_SOURCE = `^[ \\t]*(?:export[ \\t]+)?([A-Z_][A-Z0-9_]{1,60})\\s*=\\s*${ENV_VALUE_SOURCE}`;
const ENV_BODY_LINE = new RegExp(`^\\s*(?:export\\s+)?([A-Z_][A-Z0-9_]{2,})\\s*=\\s*${ENV_VALUE_SOURCE}`);

/** `KEY="value"` and `KEY='value'` — the quotes are syntax, not the secret. */
function stripEnvQuotes(value) {
  return String(value ?? '').replace(/^["']|["']$/g, '');
}

/** Was the raw value written inside quotes? Quotes make its spaces part of one token. */
function isQuotedValue(raw) {
  return /^(["'])[\s\S]*\1$/.test(String(raw ?? ''));
}

/**
 * Base64 writes its padding as one or two trailing `=`. That pad is not an
 * assignment operator, and letting it exempt the value made a padded key
 * invisible while the same key unpadded was blocked. Every other `=` still means
 * "this is an expression, not a literal secret".
 */
function withoutBase64Pad(text) {
  return String(text ?? '').replace(/={1,2}$/, '');
}

/**
 * A `${NAME}` reference is interpolation, not a literal secret. A value that only
 * *contains* `${` without a closing brace is something a human typed:
 * `Sup3r${S3cret!x` is a password, and treating any `${` as an expression sent it
 * upstream. The same holds for a lone backtick (`Sup3r\`S3cret!x`). What is left
 * is a real template literal, and those carry the punctuation of code — a call, a
 * regex, two backticks that quote something: `` `job_${id.replace(/-/g, '')` ``.
 */
function hasTemplateSyntax(text) {
  if (/\$\{[^}]*\}/.test(text)) return true;
  if (!/`|\$\{/.test(text)) return false;
  return /[()[\]/;\\]/.test(text) || (text.match(/`/g) ?? []).length > 1;
}

/**
 * A `user:password` pair is structural, not statistical: the colon separates two
 * credentials, and `sa:sa` is complete at five characters. Entropy cannot see that,
 * and requiring a digit left the classic pair open — `DB_PASS=admin:letmein`,
 * `root:toor` and `postgres:postgres` were forwarded. Only alphabetic pairs qualify,
 * and a key that names a *mode* of such a pair (`AUTH_MODE`, `AUTH_SCHEME`,
 * `TOKEN_TYPE`, `SECRET_BACKEND`, `LOG_LEVEL`) is a setting, not a credential:
 * `basic:digest`, `bearer:jwt` and `vault:file` stay exempt. Ports and dotted hosts
 * carry digits and never match the pair shape.
 */
const PAIR_QUALIFIERS = new Set([
  'MODE', 'TYPE', 'SCHEME', 'BACKEND', 'LEVEL', 'FORMAT', 'POLICY', 'CLASS',
  'KIND', 'VARIANT', 'ALGORITHM', 'STRATEGY', 'PROVIDER', 'DRIVER',
]);

/**
 * A right side that names a *mode*, a scheme, a backend or a log level turns the
 * pair into a configuration value no matter what the key is called: a
 * `*_PASS`/`PASSWORD` key holding `basic:digest` is the authentication mode, not a
 * credential. The key word alone must not outrank the explicit mode word on the
 * value side. A real pair (`admin:admin`, `root:toor`, `sa:sa`, `user:secretpw`)
 * names none of these words, so it stays caught.
 */
const PAIR_VALUE_QUALIFIERS = new Set([
  'basic', 'digest', 'bearer', 'jwt', 'vault', 'file', 'ldap', 'oauth', 'saml',
  'md5', 'sha256', 'info', 'debug', 'warn', 'error', 'none', 'mock', 'stub',
  'env', 'auto',
]);

function isUserPasswordPair(text, lhs) {
  if (!/^[A-Za-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$/.test(text)) return false;
  const right = text.slice(text.indexOf(':') + 1).toLowerCase();
  if (PAIR_VALUE_QUALIFIERS.has(right)) return false;
  if (!hasSecretWord(lhs)) return false;
  return !leftHandTokens(lhs).some((token) => PAIR_QUALIFIERS.has(token));
}

// A key path can put a wrapper between a credential and its value — a tool
// argument object arrives as `{"password":{"value":"…"}}` — so the hint search
// steps over the wrapper words and stops at the first segment that names a
// *property* of a credential instead of the credential. `password.strength` is
// metadata and `token.count` is a number: neither value is the secret, and
// masking one would rewrite a payload for nothing.
const CREDENTIAL_WRAPPER = new Set([
  'VALUE', 'RAW', 'TEXT', 'PLAIN', 'LITERAL', 'CURRENT', 'PREVIOUS', 'NEW', 'OLD',
]);
const CREDENTIAL_PROPERTY = new Set([
  'STRENGTH', 'MODE', 'TYPE', 'LENGTH', 'COUNT', 'POLICY', 'EXPIRES', 'EXPIRY',
  'TTL', 'ROTATION', 'HINT', 'DESCRIPTION', 'LABEL', 'ID', 'NAME', 'SCHEME',
  'FORMAT', 'ALGORITHM', 'MIN', 'MAX', 'REQUIRED', 'ENABLED', 'STATUS', 'BACKEND',
]);

/** Is this literal value opaque enough to be a credential rather than ordinary code or text? */
export function looksOpaque(value) {
  // A base64 pad is part of the literal, not an assignment operator.
  const text = withoutBase64Pad(String(value ?? '').trim());
  if (text.length < 12) return false;
  if (/\s/.test(text)) return false;
  if (hasTemplateSyntax(text) || text.includes('var(') || text.includes('content=') || text.includes('://') || text.includes('=')) return false;
  if (BENIGN_VALUE.some((pattern) => pattern.test(text))) return false;
  const eff = tokenEfficiency(text);
  const entropy = entropyBits(text);
  // Readable compound words (`omp-inspector-overlay`, `Qwen2.5-0.5B-Instruct`)
  // tokenize at or above 2.2 characters per subword; random key material does not.
  return (entropy >= 3.8 && eff <= 2.5) || (/[0-9]/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text) && entropy >= 3.7);
}

// A password is one token a human typed, not a path, a URI, a version or a
// hyphenated config word. `rootpass1234` and `Sup3rS3cretP@ssw0rd` qualify;
// `production`, `mysql8`, `v1.2.3`, `ap-northeast-2`, `db.internal` and
// `/var/lib/mysql8` do not — which is what keeps a legitimate sample file or an
// ordinary `.env` exempt from the credential rules.
const TYPED_SECRET_MIN = 8;
const TYPED_SECRET_MAX = 64;
const CONFIG_SHAPED = [
  /^(?:[.\/~]|[A-Za-z]:[\\/])/,                          // a filesystem path
  /^(?:https?|git|file|node|npm|ssh|s3|gs|data|wss?):/i, // a URI scheme
  // Three or more readable segments: versions, host names, dashed identifiers,
  // `Qwen2.5-0.5B-Instruct`. `_` is not one of them — dotenv keys are themselves
  // underscore-separated, so `pw_change_2026` is a password with a shape, not a
  // config name.
  /^[A-Za-z0-9]+(?:[-./:][A-Za-z0-9]+){2,}$/,
  /^v?[0-9]+(?:\.[0-9]+)+$/,                             // a version
  /^[0-9][0-9._:/-]*$/,                                  // digits with separators
];
// An underscore-joined config identifier, read only by call-argument propagation
// (the typed-secret shape above deliberately keeps `_` tokens). A segment is a
// readable word of at most 12 letters whose capitals are camel humps or one
// all-caps run, a number run with at most one unit letter (`1A`, `001`, `2024`),
// or a word of at most four letters glued to a number, at most one of those
// (`V20`, `LRS2`, `Id1`). A digit inside a longer word (`Sup3r`, `hunter2`) and a
// camelCase run of capitals (`XkQzMn`, `QxZvBnMk`) are not this shape.
// The spelling of a variable or key name: ALL_CAPS with digits, or lowercase words
// with no digit joined by `_`, `.` or `-`.
const LOOKUP_NAME = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[a-z]+(?:[_.-][a-z]+)*)$/;
// The mask's own pseudonym (`[SECRET_1]`): reading it back as an argument would
// report the placeholder itself as a credential and fail the recheck.
const PLACEHOLDER_PSEUDONYM = /^\[[A-Z][A-Z0-9]*_[0-9]+\]$/;
function isConfigIdentifier(text) {
  const segments = String(text).split('_');
  if (segments.length < 2 || segments[0] === '*') return false;
  let gluedSegments = 0;
  for (const segment of segments) {
    if (segment === '*') continue;
    if (/^[0-9]{1,4}[A-Za-z]?$/.test(segment)) continue;
    const glued = /^([A-Za-z]{1,4})[0-9]{1,2}$/.exec(segment);
    const word = glued ? glued[1] : segment;
    if (!/^[A-Za-z]{1,12}$/.test(word)) return false;
    const capitals = (word.match(/[A-Z]/g) ?? []).length;
    if (capitals > 2 && !/^[A-Z]+$/.test(word)) return false;
    if (!glued) continue;
    gluedSegments += 1;
    if (gluedSegments > 1) return false;
  }
  return true;
}

/** Is this literal a password-shaped token rather than configuration prose? */
export function looksTypedSecret(value) {
  // Stripping the base64 pad first is what keeps `…Ao=` and `…Ao` the same
  // token: neither is an expression, and only one of them used to be blocked.
  const text = withoutBase64Pad(String(value ?? '').trim());
  if (text.length < TYPED_SECRET_MIN || text.length > TYPED_SECRET_MAX) return false;
  if (/\s/.test(text)) return false;
  // A backtick is punctuation in a typed password (`Sup3r\`S3cret!x`), not a
  // template-literal delimiter; only `${…}` interpolation disqualifies. Quotes
  // still do: a value the rules see as a quoted string is not one token.
  if (hasTemplateSyntax(text) || /["']/.test(text) || text.includes('://') || text.includes('=')) return false;
  if (CONFIG_SHAPED.some((pattern) => pattern.test(text))) return false;
  if (BENIGN_VALUE.some((pattern) => pattern.test(text))) return false;
  // Both a letter and a digit: `production` and `8080` are configuration, a
  // passphrase with a number in it is not. A symbol a password carries but an
  // identifier does not (`You`+`@`+`P@ssword`, no digit at all) plus mixed case
  // is the other shape, and requiring a digit sent it.
  if (!/[A-Za-z]/.test(text)) return false;
  if (/[0-9]/.test(text)) return true;
  return /[a-z]/.test(text) && /[A-Z]/.test(text) && /[!@#$%^&*]/.test(text);
}

// A passphrase is several words a human chose, kept together by quotes. It is not
// prose: a sentence carries punctuation, articles and a full stop, and the words
// of `this is a config note` are all dictionary text. Length plus a mixed
// alphabet plus no sentence punctuation is the shape a passphrase has.
const PASSPHRASE_MIN_WORDS = 2;
const PASSPHRASE_MIN_LENGTH = 12;
const PASSPHRASE_MAX_LENGTH = 128;
const PROSE_SHAPE = [
  /[.,;:!?]/,               // sentence punctuation
  /\s$/,                    // trailing space
  /^\s/,
];
const PROSE_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were',
  'be', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'not',
  'it', 'as', 'from', 'note', 'example', 'value', 'config', 'comment', 'copy',
  'put', 'use', 'here', 'please', 'yes', 'no', 'true', 'false',
]);

/** Is this quoted value a passphrase rather than a quoted sentence? */
export function looksLikePassphrase(value) {
  const text = String(value ?? '').trim();
  if (text.length < PASSPHRASE_MIN_LENGTH || text.length > PASSPHRASE_MAX_LENGTH) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < PASSPHRASE_MIN_WORDS) return false;
  if (PROSE_SHAPE.some((pattern) => pattern.test(text))) return false;
  // Prose is mostly function words; a passphrase is mostly not.
  const proseWords = words.filter((word) => PROSE_WORDS.has(word.toLowerCase())).length;
  if (proseWords / words.length > 0.4) return false;
  return /[A-Za-z]/.test(text) && (/\s/.test(text) || /[0-9]/.test(text));
}

/**
 * A flat entropy floor cannot reach a short secret: an 8-character token has at
 * most 3 bits per character, so `hunter22` (2.75) or `Kq7Rt2Xz9Lm4Np8Q2Wv3`
 * (4.22 at 20 characters) sat under 4.3 forever while the 23-character spelling
 * of the same alphabet cleared it. The floor therefore scales with length and
 * only saturates at the old value, so nothing that passed before stops passing.
 */
const OPACITY_CEILING_BITS = 4.3;
const OPACITY_SATURATION_LENGTH = 24;
const OPACITY_PER_CHARACTER = 0.045;

export function opacityFloor(length) {
  const missing = Math.max(0, OPACITY_SATURATION_LENGTH - length);
  return OPACITY_CEILING_BITS - missing * OPACITY_PER_CHARACTER;
}

/**
 * A base64 body of an encoded document decodes to text; a typed password
 * decodes to noise. This is what keeps `b3BlbnNzaC1rZXktdjEAAAA` (an
 * `openssh-key-v1` header) out of the credential rules while `Kq7Rt2Xz9Lm4Np8Q`
 * (25% printable) stays in.
 */
const ENCODED_TEXT_PRINTABLE_RATIO = 0.75;

export function looksEncodedText(value) {
  const text = String(value ?? '');
  if (text.length < 12 || !/^[A-Za-z0-9+/=_-]+$/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let bytes;
  try {
    bytes = Buffer.from(padded, 'base64');
  } catch {
    return false;
  }
  if (bytes.length === 0) return false;
  let printable = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable += 1;
  }
  return printable / bytes.length >= ENCODED_TEXT_PRINTABLE_RATIO;
}

// A value that says what it is even when its key does not: `rootpass1234`.
const PASSWORD_SHAPED = /(?:pass|pwd|s3cret|secret|token|credential)/i;

// A call whose arguments are quoted string literals: `SecretStr("<secret>")`,
// `re.compile(r"cuda[ _-]?(\d{1,2})")`. The call is code, but the literal inside it
// is a value someone typed, so the literal — not the call — is what gets judged.
// A call with no quoted argument (`Sup3r(S3cret!x)`) is not this shape at all.
const CALL_LITERAL = /^[A-Za-z_$][A-Za-z0-9_$.]*\s*\(\s*[rRbBuU]{0,2}(["'])((?:(?!\1)[^\\\n]|\\.){1,200})\1\s*(?:,[^\n]*)?\)$/;

/**
 * The SEC-03 rule: a secret keyword on the LHS **or** high entropy plus low token efficiency.
 * In addition, literal values must meet the opacity criteria (not plain English words or code expressions).
 *
 * `body` says the value sits in a `.env`-shaped run of assignments, where a
 * neutral key plus a letters-and-digits token is evidence enough: `MYSQL_ROOT`
 * names no secret, yet `MYSQL_ROOT=hunter22` is a password. Outside a body that
 * same shape is ordinary configuration (`APP_ENV=production1`), so the extra
 * latitude is opt-in and never applies to a lone assignment.
 *
 * DOCUMENTED RESIDUALS — the exemptions this build was measured to keep.
 *
 * Each line was measured against this code, so the list states where the rules
 * end rather than where they would be convenient to end. It is not a claim that
 * nothing else escapes: it names the shapes that are deliberately and knowingly
 * out of scope, and `pii-mask.test.mjs` asserts every one of them.
 *
 * 1. An unquoted value that contains a space is never a secret: a passphrase
 *    written without quotes (key `DB_PASS`, value `correct horse battery`) is
 *    read as config prose and is sent verbatim, while the same value written
 *    inside quotes is caught. The space is the whole signal, so an unquoted
 *    passphrase of two or more words is out of scope by construction.
 * 2. A *quoted* value is exempt when it reads as prose: 12–128 characters, two or
 *    more words, and either sentence punctuation (`,` `;` `:` `!` `?`), or a
 *    leading/trailing space, or more than 40% function words (`the`, `is`, `of`,
 *    …). So a quoted `the quick brown fox is not here`, a quoted
 *    `correct, horse battery`, a quoted `note for you` and the 10-character
 *    quoted `short note` are sent. A quoted value of two or more words with no
 *    punctuation and few function words is *blocked* — a quoted
 *    `we will ship the report on friday`, `Hello World 2026`,
 *    `The Quick Brown Fox` or `friday report` is refused. That direction is
 *    fail-closed: a false positive on quoted prose, not a leak.
 * 3. A value shorter than 8 characters is a secret on two paths only, and both
 *    need a key. (a) An alphabetic `user:password` pair under a credential-named
 *    key, which is structural rather than statistical — `DB_PASS=a:b`,
 *    `DB_PASS=ab:cd` and `DB_PASS=sa:sa` are caught, in a body and in a JSON
 *    member too. (b) Any non-empty value under an *unambiguous* credential key in
 *    a structural shape (see 17). A key that only names a mode (`DB_PASS`,
 *    `AUTH`) or no credential at all (`MYSQL_ROOT`) keeps the floor, so
 *    `DB_PASS=hunter2` and `DB_PASS=abc` are sent while
 *    `{"password":"hunter2"}` is caught. In a `.env` body the floor is on
 *    the *line* as well: a value under 3 characters is not counted as an
 *    assignment, so `DB_PASS=ab\nMYSQL_ROOT=hunter22` is one assignment, not two,
 *    and the neutral key is never reached.
 * 4. The anchored `.env` rule only reads an all-uppercase key (`[A-Z_][A-Z0-9_]*`),
 *    but the mid-line shape reads any identifier key, so a lowercase or camel-case
 *    key is caught: `db_pass=Sup3rS3cret!x`, `dbPass=Sup3rS3cret!x` and
 *    `db_pass=admin:admin` are secrets. A key glued with no separator is one token
 *    (`dbpass` → `DBPASS`), which is not on the secret-word list, so
 *    `dbpass=Sup3rS3cret!x` and `dbpass=admin:admin` are sent.
 * 5. A base64 value that decodes to mostly printable text is treated as an
 *    encoded document and exempt (`looksEncodedText`), so a base64-encoded
 *    secret — `API_KEY=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRleHQ=` — is sent. Base64
 *    of random bytes is caught, which is the shape a real key has.
 * 6. `=` anywhere but the end still means "an expression, not a literal", and
 *    more than two trailing `=` is not valid base64 padding: `API_KEY=Kq7R=t2X`
 *    and `API_KEY=Kq7Rt2Xz9Lm4Np8Q===` are sent. One or two trailing pads are
 *    narrow enough to keep the literal a literal, and are caught.
 * 7. A placeholder word is documentation only as the FIRST *segment* and only
 *    when every later segment is a noun on `PLACEHOLDER_NOUNS` or a counter:
 *    `DB_PASS=your_api_key_here`, `DB_PASS=your_company_secret99`,
 *    `DB_PASS=change_me_2026`, `DB_PASS=changeme1234` and
 *    `DB_PASS=your_company_pw` are sent. `DB_PASS=your_boss_secret99` (noun not on
 *    the list) and `DB_PASS=pw_change_2026` (word not first) are caught, and a
 *    placeholder word glued to a NON-NOUN tail (`yourSup3rS3cret99!`,
 *    `changemeKq7Rt2Xz`, `YOURS3cret99`, `<Sup3rS3cret!x>`) is a secret on every
 *    path. A placeholder word glued to a bare noun stays documentation:
 *    `DB_PASS=yourpassword`, `DB_PASS=examplepassword`,
 *    `DB_PASS=example_password`, `DB_PASS=changemepassword`, `DB_PASS=yourkey99`
 *    and `DB_PASS=todopassword` are sent — those spell out what they are, and
 *    `examplepassword` is what an `.env.example` legitimately carries.
 * 8. A comment separated from the body by a non-comment, non-assignment line stays
 *    outside the span and survives the mask, as does a comment after a
 *    single-line finding: `DB_PASS=Sup3rS3cret!x\n# rotated by hunter22` masks to
 *    `[SECRET_1]\n# rotated by hunter22`, and
 *    `MYSQL_ROOT=hunter22\nREDIS_HOST=cache1\nplain prose\n# hunter22` keeps the
 *    final line.
 * 9. A neutral key is only a credential inside a body: `MYSQL_ROOT=hunter22` on
 *    its own is configuration, and the same line beside any other assignment is a
 *    secret (`MYSQL_ROOT=hunter22\nREDIS_HOST=cache1` is caught). A colon pair
 *    under a neutral key escapes on *both* paths — alone and inside a body —
 *    because the pair shape is only consulted for a key that already carries a
 *    secret word: `MYSQL_ROOT=root:rootpass` and
 *    `MYSQL_ROOT=root:rootpass\nREDIS_HOST=cache1` are sent, and so is the same
 *    pair in a JSON member (`{"mysql_root":"root:rootpass"}`). A body needs at
 *    least two assignments for the neutral-key latitude at all, so the two-short
 *    -line body of residual 3 has none.
 * 10. A value that carries no digit and no mixed-case-plus-symbol is
 *    config-shaped: `DB_PASS=SuperSecretPass`, `DB_PASS=CorrectHorseBattery`,
 *    `DB_PASS=hunterpass` and `DB_PASS=minhasenhasecreta` are sent. A value that is
 *    digits only is config-shaped too, so `DB_PASS=84226194` is sent. (The two
 *    branches are different rules: the first needs a digit or a symbol, the second
 *    needs a letter.)
 * 11. A variable reference is not a literal: `DB_PASS=${DB_PASSWORD}`,
 *    `DB_PASS=$DB_PASSWORD` and `API_KEY=sk-${OPENAI_KEY}` are sent.
 * 12. A colon pair is `word:word` with no digit. A right side taken from
 *    `PAIR_VALUE_QUALIFIERS` (`basic`, `digest`, `bearer`, `jwt`, `vault`, `file`,
 *    `ldap`, `oauth`, `saml`, `md5`, `sha256`, `info`, `debug`, `warn`, `error`,
 *    `none`, `mock`, `stub`, `env`, `auto`) is configuration no matter what the
 *    key is called, so `DB_PASS=admin:digest`, `DB_PASS=admin:jwt`,
 *    `DB_PASS=admin:info`, `DB_PASS=admin:basic`, `DB_PASS=vault:file`,
 *    `DB_PASSWORD=basic:digest` and `DB_PASSWORD=bearer:jwt` are sent. So are a
 *    mode-worded key (`AUTH_MODE=basic:digest`, `AUTH_SCHEME=bearer:jwt`,
 *    `TOKEN_TYPE=bearer:jwt`, `SECRET_BACKEND=vault:file`,
 *    `LOG_LEVEL=info:debug`, `CIPHER=aes-256:gcm`), a port or dotted host
 *    (`DB_PASS=localhost:5432`, `DB_PASS=127.0.0.1:8080`), a schedule
 *    (`SCHEDULE=0 3 * * *`) and a bare scheme word with no colon
 *    (`DB_PASSWORD=ldap`, `PASSWORD=oauth`, `DB_PASS=mysql`).
 *
 *    `md5` and `sha256` are the two qualifier words that do NOT exempt on their
 *    own: `DB_PASS=admin:md5`, `DB_PASS=user:md5` and `DB_PASS=admin:sha256` are
 *    caught — not as pairs, which the qualifier rejects, but by the token rules,
 *    because a digit-bearing token under a secret-worded key is a secret whatever
 *    its shape (`admin:md5x` is caught the same way). A pair with no digit on
 *    either side stays exempt, so `DB_PASS=md5:md5` is sent.
 *
 *    A real pair — `DB_PASS=admin:admin`, `DB_PASS=admin:letmein`,
 *    `DB_PASS=root:toor`, `DB_PASS=postgres:postgres`, `DB_PASS=mysql:mysql`,
 *    `DB_PASS=user:secretpw`, `DB_PASS=sa:sa`, `DB_PASS=ab:cd` — names no mode
 *    word and is caught, and being structural it is caught at any width (see 3).
 *    A pair whose right side carries a digit is caught by the token rules
 *    (`user:hunter22`, `admin:pw12345`).
 * 13. `[...]` and `<...>` are documentation only when what is inside says so, and
 *    then only for their own span — never for the value around them. Judged
 *    whole, `[YOUR_KEY_HERE]`, `[redacted]`, `[API_KEY]`, `[my secret pw]`, `[x]`,
 *    `[]` and `<your_token_here>` are sent. Glued to text a human typed, the same
 *    bracket exempts nothing: `DB_PASS=[your_key]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao`,
 *    `DB_PASS=<your_token_here>Kq7Rt2Xz9`, `DB_PASS=Sup3r[redacted]S3cret99!` and
 *    `DB_PASS=[note for you]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao` are caught, in a body and as
 *    a JSON member. Everything in brackets that is not documentation is a value:
 *    `DB_PASS=Kq7[Rt2]Xz9` and `DB_PASS=Sup3r[Secret]99` are caught.
 * 14. A space still ends a bare value (see 1), so a documentation bracket that
 *    contains one ends the value at the bracket: `DB_PASS=[note for you] Kq7Rt2Xz9`
 *    and `password: [note for you] Kq7Rt2Xz9Lm4Np8Q2Wv3Ao` are sent. The glued
 *    spelling of 13 (`…]Kq7…`, no space) is what is caught.
 * 15. Object inheritance is exactly ONE level deep, and only through a wrapper
 *    word (`value`, `raw`, `text`, `plain`, `literal`, `current`, `previous`,
 *    `new`, `old`). So `{"password":{"value":"Kq7Rt2Xz9Lm4Np8Q2Wv3Ao"}}`,
 *    `{"password":{"current":"OldP@ss1x","new":"NewP@ss2x"}}` and a `password:`
 *    YAML block are caught, while a second level
 *    (`{"password":{"nested":{"value":"Kq7Rt2Xz9Lm4Np8Q2Wv3Ao"}}}`) and a member
 *    whose name is neither a wrapper nor a known property
 *    (`{"password":{"hash":"…"}}`) are sent. A property word ends the search by
 *    design (see 16), and `mask_token.lstrip` shows the wrapper rule from the
 *    other side: the sibling setting of a tokenizer's `mask_token` object is not
 *    the token.
 * 16. The hint is a key path, and a path segment that names a *property* of a
 *    credential rather than the credential ends the search: `token_count`,
 *    `password.strength`, `token_type`, `api_key.id` are metadata, so
 *    `{"token_count": 8192}` and `{"password":{"strength":"strong"}}` forward
 *    unchanged — even when the value would be a secret elsewhere
 *    (`hunter22` under `token_count` is sent). The property word outranks the
 *    credential word `token`/`password` in the same segment.
 * 17. The length floor is gone only under an unambiguous credential key — a whole
 *    key from `UNAMBIGUOUS_CREDENTIAL` (`password`, `passwd`, `pwd`, `secret`,
 *    `api_key`, `private_key`, `client_secret`, `token` standing alone) or a
 *    `*_key` whose qualifier is one of `KEY_QUALIFIERS`. There, a non-empty value
 *    that is not exempt (placeholder, `${VAR}`/env reference, boolean/`null`,
 *    mode word, documentation bracket) is a credential at any width in a
 *    structural shape: `{"password":"hunter2"}`, `password: hunter2`,
 *    `--password hunter2`, `?password=hunter2`, `{password:"P@ss1!"}`,
 *    `{"password":"544572"}`, `{"password":"admin"}` and
 *    `{"password":"qwerty1"}` are caught. A credential-named key that is NOT
 *    unambiguous keeps the floor (`DB_PASS=hunter2`, `DB_PASS=abc`), as does a
 *    neutral key (see 3), and `token` behind a unit word is not a credential at
 *    all (`kv_per_token: int`, `on_token: Callable`, `CHARS_PER_TOKEN` are sent;
 *    only `access_token`, `refresh_token`, `auth_token`, `id_token`,
 *    `session_token`, `csrf_token`, `oauth_token`, `api_token`, `bot_token`,
 *    `db_token` and `secret_token` qualify).
 * 18. Two value shapes are read as names rather than as credentials, whatever the
 *    key: a hyphenated lowercase label (`fixture-not-a-real-key`,
 *    `never-propagate` — any width), a bare type annotation under an unquoted
 *    value (`api_key: Optional[str]`, `kv_per_token: int`), a value spelled
 *    exactly like its own key (`api_key=api_key`), and a value that is only a
 *    secret word (`secret: 'SECRET'`, `private_key: 'SECRET'` — the word alone,
 *    any case). The first three are what a source tree is full of; the fourth is
 *    a placeholder spelled with the credential's own name.
 * 19. Value shape classes (see `classifyCodeValue`). In a source-code shape
 *    (`key: value`, `key = value`) an UNQUOTED value that is a whole call, member
 *    chain, subscript, `new X()`, f-string, `${…}`/`${{…}}`/`$X`/`!Ref` reference,
 *    schema word or several words is not a value, so it is sent under any key:
 *    `password=hunter2()`, `password: Sup3r(S3cret!x)` (a call there),
 *    `token = self._token`, `password: ${{ secrets.DB_PASSWORD }}`,
 *    `password: %(db_password)s`, `password: required`,
 *    `Password: enter it when prompted`. `$` names a reference only when an
 *    all-capital variable name follows (`$DB_PASSWORD`); `password: $ecret99` is a
 *    literal and is caught. Under a credential key, a quoted argument of a call is
 *    judged as a literal only when it is SHAPED like a secret (a known key prefix,
 *    or the typed-secret shape: entropy, or mixed case with a digit or a symbol) —
 *    here the key and the call naming a credential are NOT evidence for the value,
 *    because the key already claimed it and the call is read through it. (The
 *    keyless rule below reaches the opposite verdict on purpose: with no key on the
 *    left the call's name is the only evidence there is.) So
 *    `password=SecretStr("<secret>")`, `password = get_secret("<secret>")`
 *    and the fallback of a lookup (`password = os.getenv("DB_PASS", "<secret>")`,
 *    `password: os.environ.get("X", "<secret>")`) are caught, while a lookup
 *    name or a configuration fallback is sent: `password = os.getenv("DB_PASS",
 *    "postgres")` (also `"5432"`, `"pg"`), `secret = os.getenv("SECRET", "dev")`,
 *    `secret_key = config.get("secret_key", "default")`,
 *    `password = keyring.get_password("svc", "user")` and
 *    `password: get_secret("x")`. A weak password passed as a fallback
 *    (`os.getenv("DB_PASS", "hunter")`) is therefore sent too: shape is the only
 *    evidence an argument carries. A regex argument (escape, group, quantified
 *    class) is a pattern: `_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")` and
 *    `_CUDA_VERSION_PATTERN = re.compile(r"cuda[ _-]?(\d{1,2})")` are sent.
 *    Under a CREDENTIAL KEY the call is not read at all — `str("<secret>")` as
 *    the value of a credential key is judged as its literal — but a call OUTSIDE
 *    any credential key is read by the keyless call-argument rule below. There is
 *    no expression class anywhere else: a quoted value, a
 *    tool-argument string, a `.env` line, a URL query and a CLI flag carry
 *    literals, so `DB_PASS=Sup3r(S3cret!x)`, `{"password":"Sup3r(S3cret!x)"}`,
 *    `password: Sup3r(S3cret)99` (not a call: text follows the `)`) are caught.
 *    The class is read from the value's own span (`scanValueSpan`), never from the
 *    rest of the enclosing line: the span ends at a depth-0 `,` `;` `]` `}` `)`, a
 *    comment (`#` after whitespace, `//`, `/*`, `<!--`, ` -- `), a group standing
 *    after whitespace, or the end of the line, so a flow mapping
 *    (`{ user: admin, password: Sup3rS3cret99 }`), a flow sequence of mappings
 *    (`users: [{name: admin, password: Sup3rS3cret99}]`), a bare-token member, a trailing
 *    brace, `/* … *\/`, `… -- see vault`, `… [2026]`, `… {from vault}`,
 *    `… <!-- rotated -->` and `… (a) (b)` are caught. A bracket glued to the
 *    value stays in it.
 *
 *    THE KEYLESS CALL-ARGUMENT RULE, stated as its exact width. A quoted argument
 *    of a call with no credential key on the left is masked (MASK ONLY: replaced,
 *    request still sent, never refused) when BOTH hold:
 *      (i) the call qualifies — its name, read as identifier WORDS, is one of
 *          `secret`, `secrets`, `password`, `passwd`, `passphrase`, `token`,
 *          `apikey`/`api_key`, `credential(s)`, `creds`, `decrypt`, `unseal`,
 *          `vault`, `getenv`, `environ`, `dotenv` — or another quoted argument in
 *          the same call carries a secret word. `tokenize`, `secretive`,
 *          `vaultless` and a bare `key` do NOT qualify, so their argument is sent;
 *      (ii) the literal itself is secret-shaped (a provider key prefix, or the
 *          typed-secret shape) and is not a regex pattern. A literal that holds a
 *          secret word is skipped only when it is spelled as a lookup name —
 *          all caps, digits optional (`DB_PASSWORD`, `API_KEY_2`, `PASSWORD`,
 *          `AUTH_TOKEN`) or lowercase words with no digit joined by `_` `.` `-`
 *          (`db_password`, `api.token`) — so that exact width is sent;
 *          `MyPassword_2025`, `my_secret_44xQ` and `api_token_9f2k3m` are values
 *          and are judged by shape.
 *    Where it masks: in any position — a wrapper call (`console.log(get_secret(…))`)
 *    does not hide the inner one, a backtick span is no escape, a live
 *    `${decrypt(…)}` interpolation is masked, and nesting is read to any depth
 *    inside the span bound of 5 (`decrypt(str(…))`,
 *    `get_secret(os.environ.get("X", …))`, `a(b(c(…)))`). Within the same
 *    text, another quoted literal with the same delimiter (`"…"`, `'…'`, `` `…` ``)
 *    that is exactly the value is masked with it, but only when the value itself
 *    carries evidence (`looksOpaque`, both a lowercase and an uppercase letter, or
 *    one of exactly `!` `@` `#` `$` `%` `^` `&` `*` — `?`, `~` and every other
 *    punctuation mark are not evidence, so `hunter2!x` propagates while
 *    `hunter2?x` and `p~ssw0rd1` do not) — a lowercase word with digits
 *    (`utf8_bin`, `node20x1`, `python39`, `user_123`), or an underscore-joined
 *    identifier (`isConfigIdentifier`: every segment a word of at most 12 letters
 *    with at most 2 capitals or all capitals, a number of at most 4 digits with at
 *    most one unit letter, a lone `*` after the first, and at most one word of at
 *    most 4 letters glued to a 1–2 digit number — `Prod_001`, `Standard_LRS2`,
 *    `Node_V20`, `us_east_1A`, `cron_0_0_*`) that is not opaque, is masked in the
 *    call and does NOT propagate, because copying that verdict onto
 *    `const codec = "…"` or `env === "…"` would rewrite unrelated code. A password
 *    spelled the same way (`Summer_2024`, `Letmein_007`, `Tiger_2024_A`, and every
 *    all-lowercase `word2_2025`) is shape-identical to those, so it does not
 *    propagate either. The value is never forwarded — except as residual 8
 *    describes: a surviving quoted copy makes `recheckSerialized` refuse the
 *    request (422), the outcome cases 1–3 describe.
 *    What it does NOT mask, and why:
 *      1. an unquoted argument or a bare copy elsewhere in the text — not a
 *         literal; the same value then survives and `recheckSerialized` refuses
 *         the request (422, `recheck_failed`). A leak is never forwarded, except
 *         as residual 8 describes;
 *      2. a copy in a different message or tool-argument slot than the masked
 *         call — this detector reads one string at a time (per-slot), so that
 *         copy is unreachable and the request is refused with 422 the same way;
 *      3. a value that is only PART of a longer token (`…Store`, `/opt/…/bin`,
 *         `"user_…"`) — rewriting a fragment corrupts unrelated bytes, so it is
 *         left byte-identical (and the request is refused if it survives);
 *      4. an argument delimited by backticks (`get_secret(`…`)`) or one whose inner
 *         text carries an escaped quote — the argument reader accepts `"…"` and
 *         `'…'` only, so such an argument is neither masked nor recorded and the
 *         value is sent. (A CALL inside a backtick span is still read; only the
 *         argument's own delimiters are restricted.)
 *      5. a call whose `(` through its matching `)` is longer than 401 characters
 *         (the `)` sits more than 400 characters after the `(`) — 401 is masked,
 *         402 is not. The span may cross line breaks, but not that bound. Inside
 *         the bound every `"…"`/`'…'` argument literal that stays on one line is
 *         judged wherever it sits, so a long earlier argument cannot hide a later
 *         secret; a literal with a raw line break between its quotes is never
 *         read, and its value is sent;
 *      6. a credential-free call (`str(…)`, `wrap(…)`, `tokenize(…)`) when no
 *         credential-naming call is nested inside it — shape alone is not evidence
 *         enough to rewrite a call's bytes;
 *      7. the keyed paths keep their own residuals above — this rule neither
 *         widens nor narrows them;
 *      8. KNOWN LEAK, pre-existing, unfixed, and not a 422 — a shielded range
 *         (`shieldRanges` in `shield.mjs`) carries the value out raw, by two
 *         different mechanisms:
 *         (a) the shielded shape IS the argument, and nothing on this rule masks
 *             it: neither the call's copy nor any other is masked, both go raw,
 *             and the request is `sent`. Two causes reach that outcome:
 *             — shield-suppressed: a git SHA-1 or SHA-256, an integrity digest
 *               (`sha384-…`) is secret-shaped, so without the shield a
 *               `generic_secret:call-argument` finding would exist; `collectSpans`
 *               drops every finding that `overlapsShield`, which is what removes
 *               it;
 *             — not shape-eligible: a UUID (`550e8400-…`) or a loopback host
 *               (`localhost`, `127.0.0.1`) already fails `isSecretShaped`, so this
 *               rule records nothing whether or not a shield is present — the
 *               shield is not the cause here (`127.0.0.1` alone yields an
 *               `ipv4_address` finding, not a call-argument one). They do carry a
 *               genuine shield-caused leak on the KEYED path, where a UUID
 *               assigned to a `password` key is caught as
 *               `generic_secret:inline-assignment` unshielded and yields no finding
 *               shielded;
 *         (b) the value is a FRAGMENT of a shielded span — an npm-scope path
 *             (`@pkg/<S>`), a `data:` URL, a hash fragment. The call's copy is
 *             masked, the shielded copy is left byte-identical (fragment, see 3),
 *             and `recheckSerialized` in `gate.mjs` skips every occurrence a
 *             shield covers, so the request is `sent` with that copy raw.
 * 20. An unquoted all-letter word (`[A-Za-z_$]+`) is an identifier where the syntax
 *    around it is code — the key follows `{` or `,`, the value is followed by `,`
 *    `}` `;` or `)`, or the shape is `key = value` — and a literal elsewhere. So
 *    `password: pw,`, `{ password: hashedPassword, email }`, `{password: admin}`,
 *    `password: hunterpass,` and `password = hunter` are sent, while
 *    `password: hashedPassword` alone on a YAML line, `password: hunter2,` (a
 *    digit is not an identifier word) and `password = Kq7Rt2Xz9Lm4Np8Q2Wv3Ao` are
 *    caught. Outside code several unquoted words are prose:
 *    `password: correct horse 9` is sent (see 1).
 * 21. A number is never a secret, whatever the key: an unquoted value that is
 *    only digits (with an optional fraction) is a count, a port–– configuration.
 *    `{"token": 8192}`, `{"password": 0}`, `max_tokens: 4096` and `port: 5432` are
 *    sent, and so is `token = 8192`. A *quoted* digit string is still a password
 *    someone typed (`{"password":"544572"}`, `{"password":"hunter2"}`), which is
 *    what keeps `{"password":"544572"}` caught. The width of this residual is
 *    exactly a numeric-only passphrase written without quotes: `password: 544572`
 *    is sent.
 */
export function isSecretAssignment(lhs, value, { body = false, quoted = false } = {}) {
  if (isVendorExample(value)) return false;
  const text = String(value ?? '').trim();
  // A call with a quoted argument carries a literal, and the literal is the value:
  // `API_KEY=str("Kq7…")` is judged as `Kq7…`, `_CUDA_VERSION_PATTERN = re.compile(
  // r"cuda[ _-]?(\d{1,2})")` as its pattern. Any other parenthesised value is a
  // literal on this path — `DB_PASS=Sup3r(S3cret!x)` in a `.env` is not a call.
  const call = CALL_LITERAL.exec(text);
  // A regex pattern is a pattern, not a password: `re.compile(r"[A-Za-z0-9_]+")`
  // carries a character class and a quantifier, which the bracket rule and the
  // opacity rules read as a credential.
  if (call) return REGEX_PATTERN_SHAPE.test(call[2]) ? false : isSecretAssignment(lhs, call[2], { body, quoted: true });
  // A value that names another variable is not a literal on any path: `password:
  // process.env.DB_PASSWORD` and `api_key=os.environ["API_KEY"]` are references.
  if (isVariableReference(text)) return false;
  // A documentation bracket speaks for itself and for nothing around it. Judge the
  // remainder: `[your_key]Kq7Rt2Xz9` is a key written after a template, and its
  // brackets are not a space in the value. Only a value that is nothing but
  // documentation is exempt — an empty remainder is a template, not a secret.
  const remainder = withoutDocumentationBrackets(text).trim();
  if (remainder !== text) return remainder === '' || isSecretAssignment(lhs, remainder, { body, quoted });
  // `sa:sa` is a complete credential at five characters, so the length floor does
  // not apply to a pair on a secret-worded key; every other short value still ends
  // here, which is what keeps `DB_PASS=hunter2` and `DB_PASS=ab` exempt.
  if (text.length < 8) return isUserPasswordPair(text, lhs);
  // A backtick alone is punctuation a human typed in a password
  // (`Sup3r\`S3cret!x`); only a template literal is an expression.
  if (hasTemplateSyntax(text)) return false;
  // A space disqualifies a *bare* value: an unquoted sentence after `=` is config
  // prose. A quoted value is one token no matter what is inside it, so a
  // passphrase written with surrounding quotes is a secret, not four words.
  const spaced = /\s/.test(text);
  if (spaced && !quoted) return false;
  const token = withoutBase64Pad(text);
  if (token.includes('var(') || token.includes('content=') || token.includes('://') || token.includes('=')) return false;
  if (BENIGN_VALUE.some((pattern) => pattern.test(text))) return false;
  // A placeholder is documentation on every path, not only inside a body:
  // `DB_PASS=changeme1234` carries a digit and used to be refused as a secret.
  if (isPlaceholderValue(text)) return false;
  if (looksEncodedText(token)) return false;

  // A secret keyword on the key plus a typed-looking value is enough. The old
  // 12/16-character floors made `rootpass1234` and `Sup3rS3cretP@ssw0rd` read as
  // ordinary configuration, so a single-line `.env` body reported nothing.
  if (hasSecretWord(lhs)) {
    if (spaced) return looksLikePassphrase(text);
    if (isUserPasswordPair(text, lhs)) return true;
    return looksOpaque(text) || looksTypedSecret(text);
  }
  if (spaced) return false;
  // A key with no secret word can still hold one: `MYSQL_ROOT=rootpass1234`. The
  // value itself names what it is, so the key does not have to.
  if (looksTypedSecret(text) && PASSWORD_SHAPED.test(text)) return true;
  if (tokenEfficiency(text) <= 2.2 && entropyBits(text) >= opacityFloor(text.length)) return true;
  if (body && looksTypedSecret(text) && tokenEfficiency(text) <= 2.8 && entropyBits(text) >= 2.7) return true;
  return false;
}

// ── detection ────────────────────────────────────────────────────────────────

function finding(rule, start, end, text, extra = {}) {
  const customScore = typeof extra.score === 'number' ? extra.score : (BASE_SCORE[rule] ?? 0.9);
  return {
    rule,
    class: CLASS_OF[rule] ?? 'personal',
    risk: extra.risk ?? (RISK_OF[rule] ?? 'medium'),
    mandatory: extra.mandatory ?? (MANDATORY_OF[rule] !== false),
    score: customScore,
    start,
    end,
    value: text.slice(start, end),
    variant: extra.variant ?? null,
  };
}

/** Walk every match; the callback receives the whole match plus its span. */
function scan(text, re, visit) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) { re.lastIndex += 1; continue; }
    visit(match[0], match.index, match.index + match[0].length, match);
  }
}

/** Span of a capture group inside its match. */
function groupSpan(match, index) {
  const value = match[index];
  if (value === undefined) return null;
  const offset = match[0].indexOf(value);
  if (offset < 0) return null;
  const start = match.index + offset;
  return { value, start, end: start + value.length };
}

/**
 * Walk a `LHS = VALUE` assignment: the finding spans the whole assignment (the
 * LHS alone is not a secret), and the callback gets both sides.
 */
function scanAssignments(text, re, visit) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) { re.lastIndex += 1; continue; }
    visit(match[0], match.index, match.index + match[0].length, match);
  }
}

const CONTEXT_WINDOW = 40;

function nearby(text, start, end) {
  return text.slice(Math.max(0, start - CONTEXT_WINDOW), Math.min(text.length, end + CONTEXT_WINDOW));
}

const NATIONAL_ID_CONTEXT = /(?:주민|등록번호|주민번호|생년월일|rrn|resident|외국인|등록증|alien|social security|ssn)/i;
const ADDRESS_CONTEXT = /(?:주소|거주|주민등록|배송|발송|address|ship|사는|거소)/i;
const NAME_CONTEXT_BEFORE = /(?:성명|이름|신청자|작성자|담당자|고객명|수령인|예약자|회원명|계약자|직원명|학생명|고객|user name|full name)/i;
const NAME_HONORIFIC = /(?:님|씨|귀하|선생님|교수님|대표님|사장님|고객님|학부모님|원장님)/;
const BANK_CONTEXT = /(?:계좌|계좌번호|입금|송금|은행|국민|신한|우리은행|하나은행|농협|기업은행|카카오뱅크|토스뱅크|sc제일|account|bank|iban|swift)/i;
const STUDENT_CONTEXT = /(?:학번|학생번호|학사번호|수험번호|student id|matriculation|student number)/i;

const KOREAN_SURNAMES = new Set([
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송',
  '류', '유', '홍', '전', '고', '문', '양', '손', '배', '백', '허', '남', '심', '노', '하', '곽', '성', '차',
  '주', '우', '구', '민', '진', '지', '엄', '채', '원', '천', '방', '공', '현', '함', '변', '염', '여', '추',
  '석', '선', '설', '마', '기', '반', '라', '왕', '금', '옥', '육', '인', '맹', '탁', '국', '어', '은', '편',
]);
const COMPOUND_SURNAMES = new Set(['남궁', '황보', '선우', '제갈', '사공', '서문', '독고', '동방']);

// Technical nouns and honorific/role terms that share syllables with common names:
// a masking pass that rewrites `김치` or `선생님`/`고객님`/`원장님` into `[PERSON_1]님`
// is a corruption, not a protection.
const NAME_STOPWORDS = new Set([
  '김치', '김밥', '김장', '김포', '박스', '박수', '박자', '최신', '최대', '최소', '최적', '정책', '정보', '정규',
  '강제', '강조', '강의', '조건', '조합', '조정', '장치', '장점', '장문', '임시', '임의', '한글', '한도', '한계',
  '오류', '오프', '오탈자', '서버', '서비스', '서명', '신호', '신규', '신뢰', '권한', '권장', '황금', '안정', '안내',
  '송신', '송출', '홍보', '전송', '전역', '전체', '고정', '고유', '고급', '문자', '문서', '문제', '문화',
  '양식', '양방향', '손실', '배포', '백업', '백그라운드', '허용', '남은', '심층', '노드', '노출', '하위',
  '하드', '곽', '성능', '성공', '차단', '차이', '주소', '주입', '우선', '구조', '구현', '민감', '진행',
  '지연', '지역', '지정', '지원', '엄격', '채널', '원본', '원격', '천장', '방식', '방향', '공유', '공통',
  '현재', '현행', '함수', '변경', '변수', '염두', '여부', '추가', '추출', '석', '선택', '설정', '설계',
  '마지막', '기본', '기록', '기밀', '반응', '라우터', '왕복', '금지', '옥션', '육안', '인증', '맹목',
  '탁월', '국가', '어휘', '은닉', '편집', '모델', '세션', '프로젝트', '코드', '테스트', '로그', '파일',
  '경로', '데이터', '에이전트', '토큰', '메모리', '프롬프트', '보고서', '문맥', '처리', '입력', '출력',
  // Role/honorific nouns that can attach to `님`/`씨` and falsely trigger name matching:
  '선생', '고객', '원장', '대표', '사장', '팀장', '부장', '과장', '대리', '주임', '교수', '의사', '변호', '회원', '학생', '담당',
]);

// A particle inside the span means it is prose, not a name: `오탈자를`, `권한이`.
// Names do not carry a josa in their own spelling, so this is a property of the
// language rather than a list of words to excuse.
const KOREAN_PARTICLES = new Set(['를', '을', '이', '가', '은', '는', '의', '에', '께', '로', '와', '과', '도', '만', '서', '나', '며']);

function looksLikeKoreanName(candidate) {
  const text = String(candidate ?? '');
  if (!/^[가-힣]{2,4}$/.test(text)) return false;
  if (NAME_STOPWORDS.has(text)) return false;
  if (KOREAN_PARTICLES.has(text.slice(-1))) return false;
  if (COMPOUND_SURNAMES.has(text.slice(0, 2))) return text.length >= 3;
  if (!KOREAN_SURNAMES.has(text.slice(0, 1))) return false;
  if (text.length === 2) return KOREAN_SURNAMES.has(text.slice(0, 1));
  return true;
}

/**
 * Detect every span in `text`. `path`/`hint` describe where the string came from
 * (a field path, or a request key) and may only *add* context: both are caller
 * text, so nothing here may let them switch a rule off.
 */
export function detectAll(text, { path = '', hint = '' } = {}) {
  const source = String(text ?? '');
  if (!source) return [];
  // A field path or file name is context too: a value under `address` is an
  // address even when the surrounding sentence never says so.
  const contextual = resolveOverlaps(collectSpans(source, { path, hint, hintText: `${path} ${hint}` }));
  if (!path && !hint) return contextual;
  // Context can also *displace*: a hint-enabled `학번` span inside a structural
  // address outranks it in overlap resolution and leaves the rest of the address
  // unmasked. So the spans found without any caller context are a floor — a
  // contextual span replaces them only where it covers them whole. `code` is a
  // mode (no context-free names in source), not context, so the floor keeps it.
  const base = resolveOverlaps(collectSpans(source, { path, hint: hint === 'code' ? 'code' : '', hintText: '' }));
  return keepBaseCoverage(base, contextual);
}

/**
 * The credential shapes a key can arrive in. The key word is necessary and never
 * sufficient: `token_count` names a token and holds a number, `password` names a
 * credential and holds one, and only the value decides between them. So each
 * shape yields a key and a value, and the value goes through the same
 * `isSecretAssignment` every `.env` line does — `admin:admin` has no entropy and
 * is still a pair on a credential-named key.
 *
 * The span is the VALUE, never the syntax around it: masking `"password":"…"` as a
 * whole would leave text that no longer parses, and the credential is the value.
 */
const CREDENTIAL_SHAPES = [
  // A JSON member: `{"password": "admin:admin"}`. The capture stops at the closing
  // quote, so the value is already unwrapped — and it is still a quoted literal,
  // which is what makes `"hunter22;"` a password rather than a statement.
  {
    syntax: 'json-member',
    re: /"([A-Za-z_$][A-Za-z0-9_$.\- ]{0,60})"\s*:\s*"((?:[^"\\\n]|\\.){1,200})"/g,
    key: 1, value: 2, unwrapped: true,
  },
  // The same member written with single quotes — a Python or JS object literal,
  // a `repr()` of a dict, a shell one-liner: `{'password': 'admin:admin'}`. The
  // double-quoted shape required `"key":` and the unquoted one required no quote,
  // so every single-quoted credential was forwarded.
  {
    syntax: 'quoted-member',
    // Only a member position (`{` or `,` before the key) — `? 'private' : 'public'`
    // is a ternary.
    re: /(?<=(?:^|[{,])[ \t]*)'([A-Za-z_$][A-Za-z0-9_$.\- ]{0,60})'\s*:\s*'([^'\\\n]{1,200})'/gm,
    key: 1, value: 2, unwrapped: true,
  },
  // An object literal whose key is bare and whose value is quoted:
  // `{password:"P@ss1!"}`. `key-value` needs a space after the colon, and code
  // does not always write one.
  {
    syntax: 'object-literal',
    re: /(?:^|[\s,{(\[])([A-Za-z_$][A-Za-z0-9_$.\-]{0,60})[ \t]*:[ \t]*("[^"\n]{1,200}"|'[^'\n]{1,200}')/gm,
    key: 1, value: 2,
  },
  // A YAML / object-literal / label pair: `password: admin:admin`. The space after
  // the colon is required, which is what keeps `https://…`, `12:30` and a
  // `localhost:5432` value out of the key position.
  //
  // `<` and `[` are data in a value here, not delimiters: a lone one is admitted by
  // the `[\\[<]` branch, so `password: Sup3r<S3cret!x` is one value instead of a
  // one-character prefix followed by the rest of the password on the wire. The
  // balanced bodies are bounded (200 characters) so a line of unmatched brackets
  // cannot make the alternation rescan from every position.
  {
    syntax: 'key-value',
    re: /(?:^|[\s,{(\[])([A-Za-z_$][A-Za-z0-9_$.\-]{0,60})[ \t]*:[ \t]+("[^"\n]{1,200}"|'[^'\n]{1,200}'|\$\{\{[^}\n]*\}\}|(?:\$\{[^}\n]*\}|[^\s,;{}"'\[<]|\[[^\]\n]{0,200}\]|<[^>\n]{0,200}>|[\[<]){1,400})/gm,
    key: 1, value: 2,
  },
  // A quoted key with a bare value: `{"password": hunter2}` is a YAML flow mapping.
  // A quoted, array or object value under a quoted key is JSON, which the member
  // shapes above already read, so only a bare token is captured here.
  {
    syntax: 'key-value',
    re: /(?:^|[\s,{(\[])(["'])([A-Za-z_$][A-Za-z0-9_$.\-]{0,60})\1[ \t]*:[ \t]+([^\s,;{}"'\[<]{1,200})/gm,
    key: 2, value: 3,
  },
  // A URL query parameter: `?API_KEY=…` and `&API_KEY=…`. `<` and `>` are data in a
  // query value — an unencoded one is rare, and excluding it ended the value at the
  // character, so `?db_pass=Sup3r<S3cret!x` reported `Sup3r` and sent the rest.
  {
    syntax: 'url-query',
    re: /[?&]([A-Za-z_][A-Za-z0-9_.\-]{0,60})=([^&#\s"']{1,200})/g,
    key: 1, value: 2,
  },
  // A CLI flag: `--password=admin:admin`, `--password admin:admin` and the quoted
  // spelling a shell needs: `--password "admin:admin"`.
  {
    syntax: 'cli-flag',
    re: /--([A-Za-z_][A-Za-z0-9_\-]{0,60})(?:=|\s+)("[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"']{1,200})/g,
    key: 1, value: 2,
  },
  // A mid-line assignment: `the value DB_PASS=Sup3rS3cret!x is set`. The anchored
  // dotenv rule only saw a line that STARTS with an uppercase key, so every one of
  // these — and every lowercase or camel-case key — was invisible.
  {
    syntax: 'inline-assignment',
    re: /(?<![A-Za-z0-9_$.\-])([A-Za-z_$][A-Za-z0-9_$.]{0,60})[ \t]*=(?![=>])[ \t]*("[^"\n]{1,200}"|'[^'\n]{1,200}'|\$\{\{[^}\n]*\}\}|(?:\$\{[^}\n]*\}|[^\s"'`,;\[<]|\[[^\]\n]{0,200}\]|<[^>\n]{0,200}>|[\[<]){1,400})/g,
    key: 1, value: 2,
  },
];

/**
 * The value of one credential-shape match, with its quotes removed: the quotes are
 * syntax, and a span that carries them would produce `"[SECRET_1]"` — a string
 * that reads as the placeholder, not as the value.
 */
function shapeValueSpan(match, keyIndex, valueIndex, unwrapped = false) {
  const captured = match[valueIndex];
  if (captured === undefined) return null;
  // A serialized body escapes its quotes, so an unquoted value ends with the
  // backslash that escapes the terminator: the recheck read `your_password1234\`
  // where the document says `your_password1234`, lost the placeholder match and
  // refused a payload the mask had correctly exempted. An odd run of trailing
  // backslashes is that escape, never part of the value.
  const trailingSlashes = /\\+$/.exec(captured);
  const raw = trailingSlashes && trailingSlashes[0].length % 2 === 1 ? captured.slice(0, -1) : captured;
  // Search from the end of the key: `password: password` starts its value at the
  // second occurrence, and indexing from 0 put the span on the key.
  const key = String(match[keyIndex] ?? '');
  const from = match[0].indexOf(key) + key.length;
  const offset = match[0].indexOf(raw, from);
  if (offset < 0) return null;
  const wrapped = /^(["'])[\s\S]*\1$/.test(raw) && raw.length >= 2;
  const quoted = wrapped || unwrapped === true;
  let inner = wrapped ? raw.slice(1, -1) : raw;
  // An unquoted value does not own a `)` it never opened: in `repr(api_key=<redacted>)`
  // and `(set DB_PASS=Sup3rS3cret!x)` the closer belongs to the text around the
  // pair. `Sup3r(S3cret!x)` is balanced and keeps its parenthesis.
  if (!quoted) {
    while (inner.endsWith(')') && (inner.match(/\)/g) || []).length > (inner.match(/\(/g) || []).length) inner = inner.slice(0, -1);
    if (!inner) return null;
  }
  const start = match.index + offset + (wrapped ? 1 : 0);
  return { value: inner, start, end: start + inner.length, quoted };
}

/**
 * A credential is a literal someone typed. `tokenWidth = Math.max(1, …)`,
 * `firstKey = openTools.keys().next().value` and `TOKEN_RE = /…/g` are code that
 * happens to sit under a credential-named identifier: a call, a member chain, an
 * arrow function or a regex literal. Masking one rewrites a program that has to
 * keep running, so a source-code shape (`key-value`, `inline-assignment`) never
 * treats an unquoted expression as a value — `classifyCodeValue` decides that once.
 * A quoted value is a string literal in every shape, so `{"password":"Sup3r(S3cret!x)"}`
 * is a password, not a call. The anchored `.env` rule has no expression class at
 * all: `DB_PASS=Sup3r(S3cret!x)` there is a literal.
 */
/**
 * Is this key written inside a backtick span rather than in a payload? A markdown
 * inline-code span quotes a shape the way documentation does — `` `DB_PASS=…` `` is
 * a documented example, not a credential — and the rules already read a backtick as
 * template syntax. The span is counted on the key's own line, and a `\n` written as
 * an escape is a line break too: the recheck scans a `JSON.stringify` of the body,
 * where every newline of a comment becomes two characters and one parity count
 * would otherwise run across the whole file.
 */
function documentedQuoted(source, position) {
  let ticks = 0;
  for (let index = position - 1; index >= 0; index -= 1) {
    const char = source[index];
    if (char === '`') { ticks += 1; continue; }
    if (char === '\n' || char === '\r') break;
    if (char === 'n' && source[index - 1] === '\\') break;
  }
  return ticks % 2 === 1;
}

// Punctuation only code carries in an unquoted value: a block, a statement end, an
// arrow, a regex literal, a command substitution. Parentheses are not on the list —
// `Sup3r(S3cret)99` is a literal; a call is recognised by its whole shape instead.
const CODE_VALUE_SHAPE = /[{};]|=>|^\/(?![/*])|^\$\(/;

// `const password = match[2];` is a declaration whose value is an expression, and
// `let token = read();` is code. A `.env` line is never introduced that way, so a
// structural shape skips a key a declaration keyword governs.
const DECLARATION_BEFORE = /\b(?:const|let|var|return|yield|typeof|await)\s+$/;
// A quoted key (`{"password": hunter2}`, a YAML flow mapping) leads with its quote.
const STRUCTURAL_LEAD = /(?:(?:^[ \t]*(?:-[ \t]+)?|[{,(\[][ \t]*)["']?|--|[?&])$/;

// A type annotation sits where a value does: `api_key: Optional[str]`,
// `kv_per_token: int`.
const TYPE_ANNOTATION = /^(?:(?:Optional|Union|List|Dict|Callable|Sequence|Mapping|Iterable|Literal|Tuple|Set|Record|Array|Promise)\[|(?:str|int|float|bool|bytes|string|number|boolean|any|unknown|object|dict|list|tuple|None)(?:\s*\|.*)?,?$)/;
// Hyphenated words are a label (`fixture-not-a-real-key`, `never-propagate`).
const KEBAB_WORDS = /^[a-z]+(?:-[a-z]+)+$/;

/*
 * VALUE SHAPE CLASSES — decided once per unquoted value in a source-code shape.
 *
 *   (a) quoted string literal      a secret candidate (never reaches this function)
 *   (b) unquoted literal token     a secret candidate
 *   (c) code expression            identifier, member chain, subscript, call,
 *                                  `new X()`, f-string / template — never a secret,
 *                                  except a quoted literal argument of a call,
 *                                  which is judged as its own (a) value
 *   (d) reference                  `${X}`, `${{ … }}`, `$X`, `process.env.X`,
 *                                  `os.environ[...]`, `!Ref X` — never a secret
 *   (e) prose / schema word        several unquoted words, `required`, `string`
 *
 * An unquoted bare word (`pw`, `hashedPassword`) is (c) only where the syntax around
 * it is code: the key follows `{` or `,`, the value is followed by `,` `}` `;` or
 * `)`, or an assignment spaces its `=`. A YAML line (`password: hunter2`), a `.env`
 * line, a URL query and a CLI flag carry literals, so there it is (b).
 */
const CODE_SHAPES = new Set(['key-value', 'inline-assignment']);
const REFERENCE_VALUE = /^(?:\$\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Z][A-Z0-9_]*|%(?:\([A-Za-z_][A-Za-z0-9_]*\)[sdifr])|!(?:Ref|Sub|GetAtt|ImportValue|GetAZs|Select|Join)\b.*)$/;
const EXPRESSION_CHAIN = /^(?:new\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*|\([^\n]*\)|\[[^\n]*\]))+$/;
const STRING_EXPRESSION = /^(?:[fF][rR]?|[rR][fF])["']|^`/;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*$/;
// A regular expression carries escapes, groups, alternation or a quantifier on a
// character class — syntax no password uses.
const REGEX_PATTERN_SHAPE = /\\[dwsbWDSB]|\(\?:|\|\(|\]\s*[+*?]|\{\d+,\d*\}/;
// A call whose name says it returns or unwraps a credential: `get_secret(…)`,
// `SecretStr(…)`, `decrypt(…)`, `load_api_key(…)`. The name is the only evidence a
// single-argument call carries, so it is read as identifier WORDS, never as a
// substring: `tokenize`, `secretive`, `vaultless` and `tokens` contain a credential
// word without naming a credential, and masking their argument rewrote ordinary
// code. `api` + `key` counts as `apikey`, so `api_key(…)` qualifies while a bare
// `key(…)` does not.
const CREDENTIAL_CALL_WORDS = new Set([
  'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'TOKEN', 'APIKEY',
  'CREDENTIAL', 'CREDENTIALS', 'CREDS', 'DECRYPT', 'UNSEAL', 'VAULT', 'GETENV',
  'ENVIRON', 'DOTENV',
]);

function namesCredentialCall(name) {
  const tokens = leftHandTokens(name);
  return tokens.some((token, index) => CREDENTIAL_CALL_WORDS.has(token)
    || (token === 'KEY' && index > 0 && tokens[index - 1] === 'API'));
}
const SCHEMA_WORD = /^(?:string|str|text|required|optional|number|integer|int|boolean|bool|any|object|hidden|masked|sensitive|redacted)$/i;

/**
 * The end of the value that starts at `start` — one forward walk that tracks quote
 * state (`'`, `"`, a backtick) and bracket depth and stops at the first of a
 * top-level `,` `;` `]` `}` `)` (a closer the value did not open), a top-level
 * comment (`#` after whitespace, `//`, `/*`, `<!--`, ` -- `) or the end of the line.
 * A bracket the value opens stays inside it, so `os.getenv("X", "Y")` is one span
 * while `{ password: X }` ends at the `}`.
 *
 * Stripping patterns off the *rest of the line* produced a new leak or a new false
 * positive in every round: `[{password: X}]`, `X -- see vault`, `X [2026]`,
 * `X {from vault}`, `X <!-- rotated -->` each left one more character in the value.
 * The value has an end, and this is where it is.
 */
const COMMENT_OPEN = /^(?:#|\/\/|\/\*|<!--|--(?:[ \t]|$))/;
const WHITESPACE_CHAR = /\s/;
const LINE_TAIL_SPACE = /[ \t]+$/;
// How far a value's end can be from its start. Every shape that calls this reader
// captures at most 200 characters, and the widest thing it can extend over is a
// quoted call argument (bounded at 400 by the call walk). Without a bound the walk
// ran to the end of the line for EVERY match, so one 10 KB line of `a: b` pairs —
// what a minified config or a JSON tool result looks like — cost the square of its
// length twice over and 16 s of blocked event loop, which is the same outage as an
// unhandled error: nothing is sent, and nothing else works either.
const MAX_VALUE_WALK = 512;

function scanValueSpan(source, start) {
  let depth = 0;
  let end = start;
  const runBefore = (index, floor = 0) => {
    let count = 0;
    for (let cursor = index - 1; cursor >= floor && source[cursor] === '\\'; cursor -= 1) count += 1;
    return count;
  };
  // A serialized body nests strings: the wire writes the message's quotes as `"`,
  // a tool argument's as `\"` and a quote inside that argument as `\\\"`. A double
  // quote carrying no more backslashes than the string the value sits in closes
  // that string; one carrying more is a quote *inside* the value
  // (`keyring.get_password(\"svc\", \"user\")` on the wire is one call).
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  // Walk back at most one bounded window when checking for enclosing serialized quotes.
  const quoteScanStart = Math.max(lineStart, start - MAX_VALUE_WALK);
  const open = new Map();
  for (let index = source.indexOf('"', quoteScanStart); index >= 0 && index < start; index = source.indexOf('"', index + 1)) {
    const level = runBefore(index, lineStart);
    open.set(level, !open.get(level));
  }
  let enclosing = -1;
  for (const [level, isOpen] of open) if (isOpen && level > enclosing) enclosing = level;
  // The partner of a nested quote carries the same escape run; a quote with a
  // shorter run is the enclosing string ending first.
  const nestedClose = (from, run) => {
    for (let cursor = from; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\n' || source[cursor] === '\r') return -1;
      if (source[cursor] !== '"') continue;
      const level = runBefore(cursor, from);
      if (level === run) return cursor;
      if (level < run) return -1;
    }
    return -1;
  };
  const limit = Math.min(source.length, start + MAX_VALUE_WALK);
  for (; end < limit; end += 1) {
    const char = source[end];
    if (char === '\n' || char === '\r') break;
    if (char === '\\') {
      let run = 0;
      while (source[end + run] === '\\') run += 1;
      const next = source[end + run];
      // An escaped `\n` ends the line, and a quote escaped no deeper than the
      // string around the value closes that string: `"arguments":"{\"code\":\"token
      // = self._token\"}"` carries `self._token` and nothing after it.
      if ((next === 'n' || next === 'r' || next === "'") && run % 2 === 1) break;
      if (next === '"') {
        if (run <= enclosing) break;
        const close = nestedClose(end + run + 1, run);
        if (close < 0) break;
        end = close;
        continue;
      }
      end += run - 1;
      continue;
    }
    // Inside a serialized string a bare `"` is that string's terminator.
    if (char === '"' && enclosing >= 0) break;
    if (char === '"' || char === "'" || char === '`') {
      // A quoted stretch is one token: a comma, a bracket or a comment marker
      // inside it is punctuation a literal carries, not syntax around the value.
      // A quote that never closes on the line is the enclosing string's terminator
      // (`"token": self._token"` in a serialized body), so the value ended before it.
      let cursor = end + 1;
      let closed = false;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '\\') {
          if (source[cursor + 1] === 'n' || source[cursor + 1] === 'r') break;
          cursor += 1;
          continue;
        }
        if (source[cursor] === '\n' || source[cursor] === '\r') break;
        if (source[cursor] === char) { closed = true; break; }
      }
      if (!closed) break;
      end = cursor;
      continue;
    }
    // A group glued to the value is the value (`Sup3r(S3cret)99`), but a top-level
    // group standing after whitespace is a note — `X (rotated)`, `X (a) (b)`,
    // `X [2026]`, `X {from vault}` — and the value ended before it.
    const grouped = char === '(' || char === '[' || char === '{';
    if (grouped && depth === 0 && end > start && WHITESPACE_CHAR.test(source[end - 1])) break;
    if (grouped) { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (char === ',' || char === ';') { if (depth === 0) break; continue; }
    if (depth > 0) continue;
    // Only text after whitespace can open a comment: `http://` and `a#b` are values.
    if (end > start && !WHITESPACE_CHAR.test(source[end - 1])) continue;
    if (COMMENT_OPEN.test(source.slice(end, end + 8))) break;
  }
  const text = source.slice(start, end).trim();
  return { text, end: start + text.length };
}

/**
 * A quoted argument of a call is judged as a literal only when it is shaped like a
 * secret. The call and the key both name a credential — `os.getenv("DB_PASS", …)`
 * names one twice — and that says nothing about the fallback: `"postgres"`,
 * `"5432"`, `"dev"` and `"default"` are configuration, a typed secret is not.
 * Shape is the only evidence an argument carries on its own.
 */
function isSecretShaped(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (PROVIDER_KEY_PATTERNS.some(({ re }) => { re.lastIndex = 0; return re.test(value); })) return true;
  return looksTypedSecret(value);
}

/**
 * Every quoted argument of a call, gated on shape: `os.getenv("DB_PASS", …)` carries
 * a literal after the lookup name, and the name is not the value. A regex pattern
 * argument is a pattern, not a secret.
 */
function callLiteralSpans(source, from, expr) {
  const spans = [];
  const literal = /(["'])((?:(?!\1)[^\\\n]|\\.){1,200})\1/g;
  let cursor = from;
  for (let match = literal.exec(expr); match; match = literal.exec(expr)) {
    const argument = match[2];
    if (REGEX_PATTERN_SHAPE.test(argument) || !isSecretShaped(argument)) continue;
    const start = source.indexOf(argument, cursor);
    if (start < 0) continue;
    spans.push({ value: argument, start, end: start + argument.length, quoted: true });
    cursor = start + argument.length;
  }
  return spans.length ? spans : null;
}

/**
 * Classify an unquoted value of a source-code shape. Returns the spans to judge as
 * literals — the value itself (b), or the quoted arguments of a call (a inside c) —
 * or `null` for a code expression, a reference or prose.
 */
function classifyCodeValue(source, keyStart, key, span, syntax) {
  const scanned = scanValueSpan(source, span.start);
  const expr = scanned.text;
  // On the wire a nested call writes its quotes escaped (`get(\"svc\")`); the
  // call shape is the same one.
  const call = expr.replace(/\\+(["'])/g, '$1');
  // A call is judged by its quoted arguments before the reference rules read the
  // whole call as a lookup: `os.getenv("DB_PASS", "<secret>")` names a
  // variable *and* carries a fallback literal, and only the name is a reference.
  if (CALL_LITERAL.test(call)) return callLiteralSpans(source, span.start, call);
  if (REFERENCE_VALUE.test(expr) || isVariableReference(expr)) return null;
  if (STRING_EXPRESSION.test(expr)) return null;
  // A parenthesised group is an expression (`(os.environ.get(KEY) or "").strip()`);
  // a secret-shaped quoted literal inside it is a value, judged as (a).
  if (expr.startsWith('(')) return callLiteralSpans(source, span.start, call);
  if (EXPRESSION_CHAIN.test(expr) || CODE_VALUE_SHAPE.test(expr)) return null;
  const lineStart = source.lastIndexOf('\n', keyStart - 1) + 1;
  const before = source.slice(lineStart, keyStart).replace(/[ \t]+$/, '');
  const after = source.slice(scanned.end).replace(/^[ \t]+/, '');
  const assignment = syntax === 'inline-assignment';
  const codeContext = /[{,]$/.test(before) || /^[,});]/.test(after) || assignment;
  // The value never runs past either end: the shape's token stops at a space
  // (`DB_PASS=Sup3r… is set`), the scanned span at the syntax around it.
  const literal = scanned.end < span.end
    ? { value: expr, start: span.start, end: scanned.end }
    : { value: span.value, start: span.start, end: span.end };
  if (codeContext) return BARE_IDENTIFIER.test(expr) ? null : [literal];
  // Outside code, several unquoted words are prose: `Password: enter it when prompted`.
  // After an `=` the value is the token before the prose (`the value DB_PASS=Sup3r…
  // is set`), after a label it is the sentence itself.
  if (/\s/.test(expr)) return assignment ? [literal] : null;
  return [literal];
}

/** Is a structural shape's value a credential literal rather than an expression? */
function isStructuralCredential(source, matchStart, keyStart, key, value, { quoted = false } = {}) {
  if (!hasSecretWord(key)) return false;
  const text = String(value ?? '').trim();
  if (!text) return false;
  // A shape whose value was written inside quotes already said where the literal
  // ends, so `"hunter22;"`, `"pa(ss)word1"` and `"a}b"` are passwords carrying
  // punctuation, not code. Only an unquoted value can be an expression.
  if (!quoted && CODE_VALUE_SHAPE.test(text)) return false;
  if (DECLARATION_BEFORE.test(source.slice(Math.max(0, keyStart - 16), keyStart))) return false;
  if (documentedQuoted(source, matchStart)) return false;
  // Below the length floor only the key vouches for the value, so the key has to
  // stand where a payload puts one: at the start of a line, after `{`, `,` or `(`,
  // or behind `--`, `?` or `&`. Mid-sentence prose (`per token: $0.03`,
  // `// secret: an`) is not a key.
  if (!quoted && text.length < 8 && isUnambiguousCredentialKey(key)) {
    const lineStart = Math.max(source.lastIndexOf('\n', keyStart - 1) + 1, 0);
    if (!STRUCTURAL_LEAD.test(source.slice(lineStart, keyStart))) return false;
  }
  // Several words are a passphrase only when they also carry a digit or a symbol.
  // Without one they are prose — `'the configured environment variable'` sits under
  // a `key` in ordinary source text — and the anchored `.env` rule keeps its own,
  // looser reading of a quoted value under a real dotenv key.
  if (/\s/.test(text) && !/[0-9!@#$%^&*+=~]/.test(text)) return false;
  return isKeyedCredentialValue(key, text, { quoted });
}

// A value that is not a literal at all, and says so: a boolean, `null`, an empty
// object, a dash standing in for one in YAML.
const NON_LITERAL_VALUE = /^(?:true|false|null|undefined|nil|none|n\/a|~|-)$/i;

/**
 * Is this value exempt *because of what it is*, once a credential-named key has
 * made it a candidate? Every exemption here is a value that never carries a
 * credential at any width: a reference to another variable, a documentation
 * placeholder, a mode word (`basic:digest`, `oauth`), a port or host pair, a URI,
 * a path, a boolean or an empty value.
 */
function isInheritedExempt(text) {
  if (!text) return true;
  if (NON_LITERAL_VALUE.test(text)) return true;
  if (isVariableReference(text)) return true;
  if (isPlaceholderValue(text)) return true;
  if (isVendorExample(text)) return true;
  if (BENIGN_VALUE.some((pattern) => pattern.test(text))) return true;
  const lower = text.toLowerCase();
  if (PAIR_VALUE_QUALIFIERS.has(lower)) return true;
  // A schema or form word describes the field (`{"password":"string"}`,
  // `password: required`); it is never the value.
  if (SCHEMA_WORD.test(text)) return true;
  const pair = /^[A-Za-z][A-Za-z0-9_]*:([A-Za-z][A-Za-z0-9_]*)$/.exec(text);
  return Boolean(pair && PAIR_VALUE_QUALIFIERS.has(pair[1].toLowerCase()));
}

/**
 * The value of a credential-shaped *key*, judged together with its shape.
 *
 * Under a key that leaves no room for another reading (`password`, `passwd`,
 * `pwd`, `db_password`, `secret`, a qualified `*_key`, `token` as the whole key,
 * `private_key`, `client_secret`) a short value is a credential exactly as a long
 * one is: `{"password":"hunter2"}` and `?password=hunter2` were forwarded because
 * the length floor that protects an unkeyed path was applied here too. Entropy
 * cannot tell `544572` from a port, so the key has to.
 *
 * Every other credential-named key keeps the floor: `DB_PASS=hunter2` is still
 * sent, and `PASS=info:debug` stays a mode.
 */
function isKeyedCredentialValue(key, value, { quoted = false } = {}) {
  const text = String(value ?? '').trim();
  // Residual 21: a number is never a secret. `{"token": 8192}` and `port: 5432`
  // are counts and ports under any key; a *quoted* digit string is still a
  // password someone typed (`{"password":"544572"}`).
  if (!quoted && /^[0-9]+(?:\.[0-9]+)?$/.test(text)) return false;
  if (isInheritedExempt(text)) return false;
  if (!isUnambiguousCredentialKey(key)) return isSecretAssignment(key, text, { quoted });
  // The credential word itself (`provider_key: 'SECRET'`) is a placeholder; a value
  // spelled like its own key (`api_key=api_key`) is the variable passed through.
  if (SECRET_WORDS.has(text.toUpperCase()) || text === key) return false;
  if (KEBAB_WORDS.test(text)) return false;
  // Residual 5 is a property of the value, not of the width: a base64 body that
  // decodes to printable text is an encoded document on every path.
  if (looksEncodedText(withoutBase64Pad(text))) return false;
  if (!quoted && TYPE_ANNOTATION.test(text)) return false;
  // Residual 6 on the structural path too: an unquoted `=` inside the value means
  // an expression (`password=a=b`), and only a trailing base64 pad is a pad.
  if (!quoted && text.includes('=') && !/^[^=]+={1,2}$/.test(text)) return false;
  // An expression is not a literal, whatever the key says: `password: readSecret()`
  // and `token: keys[i]` are code that has to keep running.
  if (!quoted && CODE_VALUE_SHAPE.test(text)) return false;
  if (hasTemplateSyntax(text)) return false;
  return true;
}

/**
 * Members of an object (or of a nested YAML block) under a credential key inherit
 * that key: `{"password":{"value":"Kq7…"}}` and
 *
 *     password:
 *       value: Kq7…
 *
 * carry the credential one level in, and no shape reads a value that begins with
 * `{` or sits on a following line. The inner pair is judged with the outer key
 * through the same path search the caller's hint uses, so a wrapper (`value`,
 * `current`, `new`) inherits while a property (`strength`, `count`, `type`) does
 * not.
 */
function scanInheritedMembers(source, visit) {
  const INNER_PAIR = /(["']?)([A-Za-z_$][A-Za-z0-9_$.\- ]{0,60})\1[ \t]*:[ \t]*(["']?)((?:[^"'\s\\\n,]|\\.){1,200})\3/g;
  const judge = (outer, match, offset) => {
    const inner = match[2];
    const key = credentialHintKey(`${outer}.${inner}`);
    if (!key) return;
    const raw = match[4];
    const quoted = Boolean(match[3]);
    const start = offset + match.index + match[0].indexOf(raw, match[0].indexOf(inner) + inner.length);
    if (start < offset) return;
    if (!isKeyedCredentialValue(key, raw, { quoted })) return;
    // A documented example in a backtick span is documentation, not a payload.
    if (documentedQuoted(source, start)) return;
    visit(start, start + raw.length);
  };

  // A JSON/JS object literal member whose value is an object, quote styles mixed:
  // `{"password":{"value":"…"}}`, `{'client_secret': {'new': '…'}}`.
  const OBJECT_MEMBER = /(["'])([A-Za-z_$][A-Za-z0-9_$.\- ]{0,60})\1[ \t]*:[ \t]*\{([^{}]{0,2000})\}/g;
  scan(source, OBJECT_MEMBER, (whole, start, end, match) => {
    const key = match[2];
    if (!hasSecretWord(key)) return;
    const body = match[3];
    const bodyStart = start + match[0].indexOf('{') + 1;
    scan(body, INNER_PAIR, (inner, _i, _e, innerMatch) => judge(key, innerMatch, bodyStart));
  });

  // A YAML block: a credential key with nothing after its colon, then an indented
  // block of pairs.
  const YAML_BLOCK = /^([ \t]*)([A-Za-z_$][A-Za-z0-9_$.\-]{0,60})[ \t]*:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))+)/gm;
  scan(source, YAML_BLOCK, (whole, start, end, match) => {
    const key = match[2];
    if (!hasSecretWord(key)) return;
    const body = match[3];
    const bodyStart = start + match[0].length - body.length;
    scan(body, INNER_PAIR, (inner, _i, _e, innerMatch) => judge(key, innerMatch, bodyStart));
  });
}

/**
 * The credential key a caller handed us, if any. A tool-argument object is split
 * into its values before detection — `{"password":"admin:admin"}` reaches the
 * detector as the bare text `admin:admin` under the key path
 * `…arguments.password` — so the key, not the text, is the only structure left.
 *
 * A wrapper key between the credential and its value says nothing about the value
 * (`{"password":{"value":"…"}}` puts it under `value`), so the search walks
 * outward to the nearest credential-named ancestor. A segment that names a
 * *property* of a credential rather than the credential itself stops the walk: the
 * value under `password.strength` is not the password, and masking `strong` would
 * rewrite a payload for nothing.
 */
function credentialHintKey(hint) {
  const text = String(hint ?? '').trim();
  if (!text) return '';
  // The gate prefixes the slot kind (`string-literal <path>`); `maskString` passes
  // the raw key path alone. Either way the path is the last whitespace token.
  const tokens = text.split(/\s+/).filter(Boolean);
  const path = tokens[tokens.length - 1] ?? '';
  // A published path may have a non-identifier key replaced by `*`; an array index
  // is a position, not a name.
  const segments = path.replace(/\[\d+\]/g, '').split(/[.>]/).map((part) => part.trim()).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // A property check comes first: `token_count` carries the secret word `token`,
  // yet its value is a number a payload needs (`8192`) and masking it would rewrite
  // the request for nothing. The property word outranks the credential word.
  const lastTokens = leftHandTokens(last);
  if (lastTokens.some((token) => CREDENTIAL_PROPERTY.has(token))) return '';
  if (hasSecretWord(last)) return last;
  // Only a wrapper (`value`, `current`) inherits: `mask_token.lstrip` is a sibling
  // setting of a tokenizer, not the token.
  if (segments.length > 1 && !leftHandTokens(last).every((token) => CREDENTIAL_WRAPPER.has(token) || token === '*')) return '';
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const ancestor = segments[index];
    if (hasSecretWord(ancestor)) return ancestor;
    if (leftHandTokens(ancestor).some((token) => CREDENTIAL_PROPERTY.has(token))) return '';
    // An unknown segment is not a wrapper, so it says nothing about the value and
    // the walk stops rather than reaching for a credential two levels up.
    if (!leftHandTokens(ancestor).every((token) => CREDENTIAL_WRAPPER.has(token))) return '';
  }
  return '';
}

/** Contextual spans win only where they cover every base span they touch. */
function keepBaseCoverage(base, contextual) {
  const replaced = new Set();
  const accepted = [];
  for (const candidate of contextual) {
    const clashes = base.filter((other) => candidate.start < other.end && candidate.end > other.start);
    if (!clashes.every((other) => candidate.start <= other.start && candidate.end >= other.end)) continue;
    accepted.push(candidate);
    for (const other of clashes) replaced.add(other);
  }
  for (const other of base) if (!replaced.has(other)) accepted.push(other);
  return accepted.sort((a, b) => a.start - b.start);
}

function collectSpans(source, { path, hint, hintText }) {
  const shields = shieldRanges(source);
  const found = [];
  const add = (rule, start, end, extra) => {
    if (start >= end) return;
    if (overlapsShield(shields, start, end)) return;
    found.push({ ...finding(rule, start, end, source, extra), path });
  };

  // ── credentials ────────────────────────────────────────────────────────────
  scan(source, /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    (value, start, end) => {
      if (!hasKeyBody(value)) return;
      add(RULE_OPENSSH_KEY, start, end, { variant: 'openssh' });
    });
  scan(source, /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY(?:\s+BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]*)PRIVATE KEY(?:\s+BLOCK)?-----/g,
    (value, start, end) => {
      if (!hasKeyBody(value)) return;
      add(RULE_PRIVATE_KEY, start, end, { variant: 'pem' });
    });

  for (const { vendor, re } of PROVIDER_KEY_PATTERNS) {
    scan(source, re, (value, start, end) => {
      if (isVendorExample(value)) return;
      add(RULE_PROVIDER_KEY, start, end, { variant: vendor });
    });
  }

  scan(source, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, (value, start, end) => {
    const parts = value.split('.');
    if (parts.length !== 3) return;
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (!header || typeof header !== 'object' || !(header.alg || header.typ)) return;
    } catch {
      return;
    }
    add(RULE_JWT, start, end, { variant: 'jwt' });
  });

  scan(source, /(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    (value, start, end) => add(RULE_AUTH_HEADER, start, end, { variant: 'authorization' }));
  scan(source, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    (value, start, end) => add(RULE_AUTH_HEADER, start, end, { variant: 'bearer' }));
  scan(source, /\bCookie\s*:\s*[A-Za-z0-9_.%$-]+=[^\n;]{8,}(?:;[^\n]{0,200})?/gi,
    (value, start, end) => add(RULE_AUTH_HEADER, start, end, { variant: 'cookie' }));

  scan(source, /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|clickhouse):\/\/[^\s"'`<>]{6,}/gi,
    (value, start, end) => {
      const match = /^[a-z0-9+]+:\/\/([^:@/\s]*):([^@/\s]+)@/i.exec(value);
      if (!match) return;
      const password = match[2];
      if (!password || password.length < 4) return;
      if (/^(?:password|passwd|pass|pwd|changeme|example|secret|test|admin|user|root|\$\{[^}]*\}|<[^>]*>|\*\*\*)$/i.test(password)) return;
      if (/\$\{|\{\{|<|>|%s|%\(/.test(password)) return;
      add(RULE_DB_URI, start, end, { variant: 'db-uri' });
    });

  const QUOTED_ASSIGNMENT = /\b([A-Za-z_$][A-Za-z0-9_$.]{0,60})\s*(?::\s*[A-Za-z0-9_<>|[\].,"' ]{1,40})?\s*=\s*(["'`])([^"'`\n]{10,200})(["'`])/g;
  scanAssignments(source, QUOTED_ASSIGNMENT, (value, start, end, match) => {
    const lhs = match[1];
    const rhs = match[3];
    // The value was written inside quotes, so its spaces are one token.
    if (isSecretAssignment(lhs, rhs, { quoted: true })) {
      add(RULE_GENERIC_SECRET, start, end, { variant: 'env-assignment', score: 0.95, risk: 'high' });
    }
  });
  // The value character class admits punctuation (`Sup3rS3cretP@ssw0rd`): the
  // old `[A-Za-z0-9._~+/-]` set skipped exactly the passwords that carry `@`,
  // `!` or `#`, and `isSecretAssignment` below decides what is actually a secret.
  const BARE_ASSIGNMENT = new RegExp(ENV_ASSIGNMENT_SOURCE, 'gm');
  scanAssignments(source, BARE_ASSIGNMENT, (value, start, end, match) => {
    const lhs = match[1];
    const raw = match[2];
    const rhs = stripEnvQuotes(raw);
    if (isSecretAssignment(lhs, rhs, { quoted: isQuotedValue(raw) })) {
      add(RULE_GENERIC_SECRET, start, end, { variant: 'bare-env-assignment', score: 0.95, risk: 'high' });
    }
  });

  // Every other syntax a credential arrives in. The anchored rule above is one
  // shape of many: a JSON member, a YAML pair, a URL query parameter, a CLI flag
  // and a mid-line assignment all carry a key that names a credential, and none of
  // them starts a line with an uppercase `KEY=`.
  const hintedKey = credentialHintKey(hint);
  for (const shape of CREDENTIAL_SHAPES) {
    scanAssignments(source, shape.re, (value, start, end, match) => {
      const span = shapeValueSpan(match, shape.key, shape.value, shape.unwrapped === true);
      if (!span) return;
      // A container value holds members of its own: `users: [{name: admin,
      // password: X}]` is one match for `users`, and the walk resumes inside it.
      if (/^[[{]/.test(span.value)) shape.re.lastIndex = span.start + 1;
      const keyStart = start + match[0].indexOf(match[shape.key]);
      if (!hasSecretWord(match[shape.key])) return;
      const judged = !span.quoted && CODE_SHAPES.has(shape.syntax)
        ? classifyCodeValue(source, keyStart, match[shape.key], span, shape.syntax)
        : [span];
      if (!judged) return;
      for (const candidate of judged) {
        if (!isStructuralCredential(source, start, keyStart, match[shape.key], candidate.value, { quoted: candidate.quoted })) continue;
        add(RULE_GENERIC_SECRET, candidate.start, candidate.end, { variant: shape.syntax, score: 0.95, risk: 'high' });
      }
    });
  }
  // A credential key whose value is an object or a nested YAML block: the inner
  // members inherit the key, so `{"password":{"value":"…"}}` and a `password:`
  // block are caught where no shape can read a `{` or a line break as a value.
  scanInheritedMembers(source, (start, end) => {
    add(RULE_GENERIC_SECRET, start, end, { variant: 'inherited-member', score: 0.95, risk: 'high' });
  });
  // The caller's key is context like any other: a tool-argument object is split
  // into its values before detection, so a bare `admin:admin` under the key
  // `password` has no structure left to read — the key is the structure.
  if (hintedKey) {
    const text = source.trim();
    const start = source.indexOf(text);
    // A tool-argument string is a string literal (class a): `{"password":"Sup3r(S3cret!x)"}`
    // was typed inside quotes, so its parentheses are characters, not a call.
    if (isStructuralCredential(source, start, start, hintedKey, text, { quoted: true })) {
      add(RULE_GENERIC_SECRET, start, start + text.length, { variant: 'hinted-value', score: 0.95, risk: 'high' });
    }
  }

  // A secret-shaped literal passed straight into a credential-naming call, with no
  // key on the left: `get_secret(…)`, `SecretStr(…)` and an env lookup whose
  // sibling argument names the credential. Shape alone is not evidence — a doc line
  // or `console.log("base64url")` carries a token too — so the call must name a
  // credential in its own name or in another argument. The finding is mask-only:
  // no key claimed the value, so the bytes are replaced and the request still goes
  // through rather than being refused.
  //
  // There is no documentation escape on this path. A sample written in a backtick
  // span is masked like any other occurrence: skipping it masked one copy of a
  // value the vault had recorded and left the other on the wire, so the recheck
  // refused the request — and a live interpolation (`${decrypt(…)}`) is code that
  // runs, not documentation. Wrapping the value in another call (`str(…)`,
  // `os.environ.get("X", …)`) is still the inner call's argument, and the literals
  // judged here are kept so quoted copies of the same value are masked with them
  // (second pass below).
  //
  // The candidates are `name(` positions, each with its own argument span read by a
  // paren counter — never a whole `name(…)` match. A whole-call match makes the
  // OUTER call consume the cursor, so `console.log(get_secret(…))` and
  // `assert.ok(decrypt(…))` were never examined and leaked; walking the inner
  // candidate independently is what keeps the credential call in view.
  const callArguments = [];
  scan(source, /\b[A-Za-z_$][A-Za-z0-9_$.]{0,60}\s*\(/g, (value, start, end) => {
    const open = end - 1;
    if (open < 0 || source[open] !== '(') return;
    let depth = 0;
    let quote = null;
    let close = -1;
    // A call may be formatted across lines — `os.getenv(\n  "DB_PASS",\n  "…"\n)` —
    // so a line break is whitespace here, not the end of the span. The span is
    // bounded by its total length (400 characters from the `(`), which keeps the
    // walk linear whatever the payload does.
    for (let index = open; index < source.length && index - open <= 400; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') { index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) { close = index; break; }
      }
    }
    if (close < 0) return;
    const inner = source.slice(open + 1, close);
    if (!inner) return;
    const innerStart = open + 1;
    // Every single-line argument literal in the span is judged, whatever its width:
    // a cap here let a long first argument hide every later one, so
    // `get_secret("<201 chars>", "…")` sent the secret. The span bound above is the
    // only width limit; a literal holding a raw line break is not matched.
    const literal = /(["'])((?:(?!\1)[^\\\n]|\\.){1,400})\1/g;
    const arguments_ = [];
    let quoted;
    while ((quoted = literal.exec(inner)) !== null) {
      arguments_.push({ text: quoted[2], start: innerStart + quoted.index + 1 });
    }
    if (arguments_.length === 0) return;
    const callName = source.slice(start, open);
    const namesCredential = namesCredentialCall(callName)
      || arguments_.some((argument) => hasSecretWord(argument.text));
    if (!namesCredential) return;
    for (const argument of arguments_) {
      // A lookup NAME (`DB_PASSWORD`, `api_key`) is a key form, not the value; a
      // literal with a secret word plus a digit, mixed case or entropy
      // (`MyPassword_2025`) is the value and is judged by shape below.
      if (hasSecretWord(argument.text)
        && (LOOKUP_NAME.test(argument.text) || PLACEHOLDER_PSEUDONYM.test(argument.text))) continue;
      if (REGEX_PATTERN_SHAPE.test(argument.text) || !isSecretShaped(argument.text)) continue;
      const argumentEnd = argument.start + argument.text.length;
      // A keyed shape already owns this value: `password: os.getenv(…)` reports the
      // literal through the credential path, and that verdict stands.
      if (found.some((span) => span.start < argumentEnd && argument.start < span.end)) continue;
      add(RULE_GENERIC_SECRET, argument.start, argumentEnd, {
        variant: 'call-argument',
        score: 0.7,
        risk: 'medium',
        mandatory: false,
      });
      callArguments.push(argument.text);
    }
  });
  // The same literal can appear again as another quoted string in this same text.
  // Masking only the call's copy recorded the value in the vault and left the other
  // bytes on the wire, and the recheck refused a request whose first verdict was
  // "mask and send". The copy has to be a quoted literal with the SAME delimiter
  // and fill it exactly: a plain substring search rewrote `abc12345Store`,
  // `/opt/python39/bin` and `"user_12345"`, which is unrelated bytes. An unquoted
  // occurrence — an identifier, a path segment, prose — stays byte-identical, and
  // the recheck refuses that request rather than forwarding the value.
  //
  // Propagation carries the value to another literal only when the value itself is
  // evidence of a secret. A lowercase word with digits (`utf8_bin`, `node20x1`,
  // `python39`, `user_123`) reaches `isSecretShaped` through its digit, but it is
  // also a codec, a runtime or a handle: masking the call's copy is one wrong byte
  // in one call, while copying that verdict onto `const codec = "…"` or
  // `if (runtime === "…")` rewrites the program the user asked about. Entropy, a
  // mixed alphabet or one of `!@#$%^&*` is the evidence required here — except in
  // an underscore-joined identifier whose segments are each a readable word or a
  // number with a unit letter (`Prod_001`, `Standard_LRS2`, `us_east_1A`,
  // `cron_0_0_*`): its case and its `*` are naming, not entropy, so only an opaque
  // value of that shape propagates.
  const carriesSecretEvidence = (text) => looksOpaque(text)
    || (!isConfigIdentifier(text)
      && ((/[a-z]/.test(text) && /[A-Z]/.test(text)) || /[!@#$%^&*]/.test(text)));
  for (const secret of new Set(callArguments)) {
    if (!carriesSecretEvidence(secret)) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scan(source, new RegExp(`(["'\`])${escaped}\\1`, 'g'), (value, start, end) => {
      const innerStart = start + 1;
      const innerEnd = end - 1;
      if (innerEnd <= innerStart) return;
      if (found.some((span) => span.start < innerEnd && innerStart < span.end)) return;
      add(RULE_GENERIC_SECRET, innerStart, innerEnd, {
        variant: 'call-argument',
        score: 0.7,
        risk: 'medium',
        mandatory: false,
      });
    });
  }

  // ── personal ───────────────────────────────────────────────────────────────
  scan(source, /(?<!\d)(\d{6})[- ]?([1-8]\d{6})(?!\d)/g, (value, start, end) => {
    const digits = value.replace(/[^0-9]/g, '');
    if (validateKoreanRRN(digits)) { add(RULE_RRN, start, end, { variant: 'pre2020', score: 1.0 }); return; }
    if (!validatePost2020RRN(digits)) return;
    const context = nearby(source, start, end);
    const hasNationalWord = NATIONAL_ID_CONTEXT.test(`${context} ${hintText}`);
    const foreigner = /외국인|등록증|alien|foreign/i.test(`${context} ${hintText}`);
    // If post-2020 RRN shape has explicit national-ID context word, score is 0.9 (mandatory pass).
    // If it has only weak context (e.g. adjacent to name or date), score is ambiguous (0.65) and risk is high.
    if (hasNationalWord) {
      add(foreigner ? RULE_ARN : RULE_RRN, start, end, { variant: 'post2020', score: 0.9, risk: 'high' });
    } else {
      const weakContext = /(?:생년|태어난|출생|확인|인증|성명|고객|번호)/i.test(`${context} ${hintText}`);
      if (weakContext) {
        add(foreigner ? RULE_ARN : RULE_RRN, start, end, { variant: 'post2020_weak', score: 0.65, risk: 'high' });
      }
    }
  });

  scan(source, /(?<!\d)(\d{3})-(\d{2})-(\d{5})(?!\d)/g, (value, start, end) => {
    if (!validateBRN(value)) return;
    add(RULE_BRN, start, end, { variant: 'business' });
  });

  scan(source, /(?<!\d)((?:\d{4}[- ]){3}\d{1,7}|\d{4}[- ]\d{6}[- ]\d{5}|\d{13,19})(?!\d)/g, (value, start, end) => {
    const digits = value.replace(/[^0-9]/g, '');
    if (!validateLuhn(digits)) return;
    if (!cardNetwork(digits)) return;
    add(RULE_CARD, start, end, { variant: cardNetwork(digits) });
  });

  const BANKING = /(?<!\d)(\d{2,6})[- ](\d{2,6})[- ](\d{2,6})(?!\d)/g;
  scan(source, BANKING, (value, start, end) => {
    const digits = value.replace(/[^0-9]/g, '');
    if (digits.length < 10 || digits.length > 16) return;
    const before = source.slice(Math.max(0, start - 60), start);
    const after = source.slice(end, Math.min(source.length, end + 30));
    const hasBankWord = BANK_CONTEXT.test(`${before} ${after} ${hintText}`);
    if (hasBankWord) {
      add(RULE_ACCOUNT, start, end, { variant: 'bank-account', score: 0.95, risk: 'high' });
    } else {
      // Unhyphenated or hyphenated digit run near weak financial/transfer context -> ambiguous low-risk candidate (score 0.55)
      const weakFinance = /(?:보내|송부|이체|금액|원|krw|입금|받을)/i.test(`${before} ${after} ${hintText}`);
      if (weakFinance) {
        add(RULE_ACCOUNT, start, end, { variant: 'account-weak', score: 0.55, risk: 'low' });
      }
    }
  });
  scan(source, /(?<!\d)(\d{8,10})(?!\d)/g, (value, start, end) => {
    const before = source.slice(Math.max(0, start - 50), start);
    if (!STUDENT_CONTEXT.test(`${before} ${hintText}`)) return;
    add(RULE_ACCOUNT, start, end, { variant: 'student-id' });
  });

  scan(source, /(?<![\w+])(?:\+82[- ]?(?:10|1[1-9]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4])|0(?:10|1[16789]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4]))[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,
    (value, start, end) => add(RULE_PHONE, start, end, { variant: 'korean' }));
  scan(source, /(?<!\d)(?:050[- ]?\d{3,4}[- ]?\d{4}|070[- ]?\d{3,4}[- ]?\d{4})(?!\d)/g,
    (value, start, end) => add(RULE_PHONE, start, end, { variant: 'korean' }));

  scan(source, /(?<![\w.-])([A-Za-z0-9._%+-]{1,})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\w.-])/g, (value, start, end, match) => {
    if (isPlaceholderEmail(match[1], match[2])) return;
    // A URI authority and an scp-style git remote are addresses, not mailboxes.
    // `ssh://deploy@host.acme.io/repo` and `git@github.com:acme/app.git` both parse
    // as `local@domain`, and masking them produced `[EMAIL_1]:acme/app.git` — a
    // remote no longer usable and no mailbox protected. The password of a
    // `scheme://user:pass@host` URI is the db_uri rule's business, not this one's.
    if (isAddressNotMailbox(source, start, end)) return;
    add(RULE_EMAIL, start, end, { variant: 'email' });
  });

  scan(source, /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g, (value, start, end) => {
    if (!validateIPv4(value)) return;
    const privateRange = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(value);
    add(RULE_IPV4, start, end, { variant: privateRange ? 'private' : 'public' });
  });

  // Road addresses: an administrative unit, then a road name with a number, then the
  // `번길 N` branch and the building number that belong to the same address. The span
  // used to stop at the first `로`, so `... 판교로 256번길 12` masked only through
  // `256` and left `번길 12` — the branch and the building number — on the wire.
  scan(source, /(?:[가-힣]{2,}(?:특별시|광역시|특별자치시|특별자치도|도|시|구|군|동|읍|면))[^\n]{0,30}?(?:로|길|번길)\s*\d+(?:-\d+)?(?:\s*번길(?:\s*\d+(?:-\d+)?)?)?(?:\s*\d+동)?(?:\s*\d+호)?/g,
    (value, start, end) => {
      const context = nearby(source, start, end);
      const structural = /(?:동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*번지)/.test(value) || /\d+호/.test(value) || /\d+동/.test(value);
      if (!structural && !ADDRESS_CONTEXT.test(`${context} ${hintText}`)) return;
      add(RULE_ADDRESS, start, end, { variant: 'road' });
    });
  scan(source, /(?:[가-힣]{2,}(?:동|읍|면|리|가))\s*\d{1,4}(?:-\d{1,4})?\s*(?:번지)?(?:\s*\d{1,3}동\s*\d{1,4}호|\s*\d{1,4}호)/g,
    (value, start, end) => add(RULE_ADDRESS, start, end, { variant: 'lot' }));

  // Only the name is masked; the honorific stays so the sentence still reads.
  scan(source, /([가-힣]{2,4})(?:님|씨|귀하|선생님|교수님|대표님|사장님|고객님|학부모님|원장님)/g, (value, start, end, match) => {
    const name = groupSpan(match, 1);
    if (!name || !looksLikeKoreanName(name.value)) return;
    add(RULE_NAME, name.start, name.end, { variant: 'honorific' });
  });
  scan(source, /(?:(?:성명|이름|신청자|작성자|고객명|수령인|예약자|회원명|계약자|직원명|학생명)\s*(?::|은|는|이|가)?\s*)([가-힣]{2,4})/g,
    (value, start, end, match) => {
      const name = groupSpan(match, 1);
      if (!name || !looksLikeKoreanName(name.value)) return;
      add(RULE_NAME, name.start, name.end, { variant: 'field-context', score: 0.90, risk: 'medium' });
    });

  // Standalone context-free 3-syllable Korean name candidate in Korean sentence structure (score 0.50, ambiguous low-risk)
  // Only enabled when hint is NOT code: code comments and strings in source files shouldn't flag every 3-syllable Korean word
  if (hint !== 'code') {
    scan(source, /(?<=[ \t\n]|^)([가-힣]{3})(?=[ \t\n,.]|$)/g, (value, start, end) => {
      if (!looksLikeKoreanName(value)) return;
      const context = nearby(source, start, end);
      if (/(?:님|씨|성명|이름|담당|작성)/.test(context)) return; // already handled
      // Only flag as ambiguous candidate if sentence is Korean prose
      if (/[가-힣]{4,}/.test(context)) {
        add(RULE_NAME, start, end, { variant: 'context-free-name', score: 0.50, risk: 'low' });
      }
    });
  }

  // ── sensitive project data ──────────────────────────────────────────────────
  // A DNS label is at most 63 characters, so the run before the dot is bounded by
  // the format it matches. Unbounded, this needed a literal dot after the run and
  // rescanned the whole of any long unbroken token from every start position: one
  // 32 000-character line of letters cost 1.6 s here and nothing else.
  scan(source, /(?:[A-Za-z0-9_-]{1,63}\.)(?:internal|corp|lan|intra|svc|prod)\b/g,
    (value, start, end) => add(RULE_INTERNAL_HOST, start, end, { variant: 'fqdn' }));

  const envBody = detectEnvBody(source);
  if (envBody) add(RULE_ENV_BODY, envBody.start, envBody.end, { variant: 'dotenv' });

  scan(source, /(?:CONFIDENTIAL|STRICTLY CONFIDENTIAL|INTERNAL USE ONLY|DO NOT DISTRIBUTE|기밀|대외비|대외주의)/gi,
    (value, start, end) => add(RULE_CONFIDENTIAL, start, end, { variant: 'marker' }));

  return found;
}

/** A `.env` body is a run of uppercase assignments carrying at least one secret. */
function detectEnvBody(source) {
  // Nothing outside the body may exempt it. The field path, the raw key and the
  // detection hint are all request text, and a key spelled `example.env` used to
  // switch this rule off and send live passwords upstream under HTTP 200. A
  // genuine sample file is recognised by its own placeholder values (the filter
  // below): that is a property of the body, not of the key it arrived under.
  //
  // Line spans come from the actual text, terminator included or not. Adding a
  // fixed `+1` assumed every line ended in `\n`, so on a CRLF body each later
  // start advanced one character too far and every span after the first drifted
  // left: an 8-line CRLF body masked to `[SECRET_1]ecret99`, and `redactForLog`
  // put the same fragment into `bridge_error.stderr` frames and the log.
  // A line ends at `\n`, `\r\n` or a lone `\r`. Splitting on `\n` alone made a
  // classic-Mac body one single line: only the last assignment could match the
  // anchors, so `env_file_body` never fired and every earlier password was sent.
  const lines = [];
  for (let at = 0; at <= source.length;) {
    const lf = source.indexOf('\n', at);
    const cr = source.indexOf('\r', at);
    const noBreak = lf === -1 && cr === -1;
    const stop = noBreak ? source.length : Math.min(lf === -1 ? Infinity : lf, cr === -1 ? Infinity : cr);
    // The terminator is not part of the line; `\r\n` is one break, not two.
    lines.push({ start: at, end: stop, text: source.slice(at, stop) });
    if (noBreak) break;
    at = stop + (source[stop] === '\r' && source[stop + 1] === '\n' ? 2 : 1);
  }

  const assignments = [];
  const secrets = [];
  const commentLines = new Set();
  let firstLine = -1;
  let lastLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const { start, end, text: line } = lines[index];
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) { commentLines.add(index); continue; }
    // `ENV_BODY_LINE` reads the value the way dotenv does: the whole token,
    // including an attached `#`, and never a whitespace-preceded comment. The
    // span, however, ends at end of line, so an inline comment is masked together
    // with the value it describes (`PASS=hunter22 # hunter22` quotes the secret).
    // The value class still stops at the comment, so a comment never decides
    // detection — only what the mask covers.
    const match = ENV_BODY_LINE.exec(line);
    if (!match) continue;
    const lhs = match[1];
    const raw = match[2];
    const value = stripEnvQuotes(raw);
    if (!value || value.length < 3) continue;
    const lineEnd = end;
    if (firstLine === -1) firstLine = index;
    lastLine = index;
    assignments.push({ start, end: lineEnd });
    // A placeholder is not evidence, and it is not evidence *against* either: it
    // only fails to count as one. It used to subtract — one
    // `REDIS_AUTH=your_redis_password` line pushed a real password under the old
    // "two or more surviving assignments" threshold and the body went unreported.
    if (isPlaceholderValue(value)) continue;
    // `body: true`: inside a run of assignments a neutral key with a
    // letters-and-digits token is a credential, which is how `MYSQL_ROOT=hunter22`
    // is caught without teaching the single-assignment path to flag config.
    if (isSecretAssignment(lhs, value, { body: true, quoted: isQuotedValue(raw) })) {
      secrets.push({ start, end: lineEnd, lhs });
    }
  }
  // The rule counts placeholders separately: the *shape* threshold is on the
  // assignments (a body is a run of them), while the evidence threshold is one
  // secret-shaped value. So one real line plus one placeholder line is still a
  // live `.env`, and a file of placeholders —
  // `MYSQL_ROOT=your_root_password\nREDIS_AUTH=changeme` — stays an example.
  // A single assignment is not a body; `generic_secret` covers that shape.
  if (assignments.length < 2 || secrets.length === 0) return null;
  // The span covers the whole block the rule matched, not only the first-to-last
  // assignment: a comment line above the first assignment that quotes the secret
  // (`# DB_PASS=Sup3rS3cret!x`) was outside the window and survived the mask. A
  // blank line does not end the block — a `.env` header comment usually sits above
  // one — so the walk steps over blank lines while it keeps finding comments.
  const opensBlock = (index) => commentLines.has(index) || !lines[index].text.trim();
  let startLine = firstLine;
  while (startLine > 0 && opensBlock(startLine - 1)) startLine -= 1;
  let endLine = lastLine;
  let lastComment = -1;
  for (let index = lastLine + 1; index < lines.length && opensBlock(index); index += 1) {
    if (commentLines.has(index)) lastComment = index;
  }
  if (lastComment !== -1) endLine = lastComment;
  return {
    start: lines[startLine].start,
    end: lines[endLine].end,
    lines: assignments.length,
    secrets: secrets.length,
  };
}

/**
 * The words a documentation value starts with, and the only things that may
 * follow them. A placeholder word is documentation only when the whole value is
 * placeholder-shaped; `pw_change_2026` carries the word `change` in the middle
 * and is a real password, so position decides, not presence.
 */
const PLACEHOLDER_WORDS = new Set(['your', 'insert', 'replace', 'change', 'example', 'placeholder', 'changeme', 'xxx', 'todo']);
const PLACEHOLDER_NOUNS = new Set([
  'password', 'passwd', 'pass', 'pwd', 'secret', 'token', 'key', 'apikey', 'api',
  'credential', 'credentials', 'creds', 'auth', 'value', 'here', 'me', 'name',
  'user', 'username', 'root', 'id', 'uid', 'host', 'redis', 'mysql', 'db', 'database',
  // Where a documentation value says whose secret it is describing. A real
  // password does not spell out `your_project_service_secret_2026`.
  'company', 'project', 'service', 'app', 'application', 'client', 'server',
  'account', 'login', 'sample', 'demo', 'example', 'test', 'local', 'dev',
  'develop', 'development', 'staging', 'stage', 'prod', 'production',
]);

// A pseudonym this guard wrote. The recheck scans the masked body, where
// `[SECRET_1]` is the only thing left of the secret it replaced, so the guard
// must read its own placeholder as a placeholder and not as a fresh secret.
const PSEUDONYM_ONLY = /^(?:\s*(?:\[[A-Z]{3,8}_\d+(?:\.\d+)?\]|__PII_[A-Z]+_\d+__)\s*)+$/;

/** A value that names itself as documentation rather than carrying a credential. */
function isPlaceholderValue(value) {
  const text = String(value ?? '');
  if (PSEUDONYM_ONLY.test(text)) return true;
  // A documentation bracket speaks for itself and for nothing else: `[your_key]`
  // is a template, so it is a placeholder only when it is the whole value. What a
  // human wrote beside it is the value, and the checks below judge that remainder
  // — `[your_key]Kq7Rt2Xz9` is a key after a template, not a template.
  const bare = withoutDocumentationBrackets(text);
  if (bare !== text) return !bare.trim() || isPlaceholderValue(bare);
  // `<...>` is documentation only when what is inside is not a secret in its own
  // right: `<your_token_here>` is a template, `<Sup3rS3cret!x>` is a password
  // written in angle brackets.
  const bracketed = /^<(.+)>$/.exec(text);
  if (bracketed) return isPlaceholderBrackets(bracketed[1]);
  if (/^\$\{[^}]*\}$/.test(text)) return true;
  // `your_root_password`, `insert-key`, `change_me_2026`: a placeholder word is
  // the FIRST segment and every later segment is documentation or a counter.
  // Matching the word anywhere made `DB_PASS=pw_change_2026` documentation too,
  // and sent a real password; a placeholder word inside a mixed value is not
  // evidence of anything.
  //
  // The word must also be a *segment*, not a prefix of one. A bare `^your`
  // prefix exempted `yourSup3rS3cret99!` — a placeholder word glued to a password
  // — on every path, a whole `.env` body included.
  const segments = text.split(/[._\-\s]+/).filter(Boolean);
  if (segments.length > 1) {
    if (!PLACEHOLDER_WORDS.has(segments[0].toLowerCase())) return false;
    return segments.slice(1).every((segment) => /^\d+$/.test(segment) || PLACEHOLDER_NOUNS.has(segment.toLowerCase().replace(/\d+$/, '')));
  }
  // One unseparated token: only the bare word, or the word followed by a noun or
  // a counter, is documentation. `yourSup3rS3cret99!` is one glued token and the
  // text after the word is not documentation, so it is a secret.
  if (/^(?:your|example|placeholder|changeme|xxx|todo)\d*$/i.test(text)) return true;
  return /^(?:your|insert|replace|change|changeme|example|placeholder|xxx|todo)\d*(?:password|passwd|pass|pwd|secret|token|key|apikey|api|credential|auth|value|here|me|name|user|username|root|id|uid|host|redis|mysql|db|database)\d*$/i.test(text);
}

/** Longest, highest-priority span wins; a phone inside an address is one span. */
function resolveOverlaps(findings) {
  const ranked = findings.slice().sort((a, b) => {
    const priority = PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule);
    if (priority !== 0) return priority;
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });
  const accepted = [];
  for (const candidate of ranked) {
    const clash = accepted.some((other) => candidate.start < other.end && candidate.end > other.start);
    if (!clash) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** Credential findings only — the redaction path for logs, memory and documents. */
export function detectCredentials(text, options = {}) {
  return detectAll(text, options).filter((item) => item.class === 'credential');
}

export const DETECTOR_RULES = Object.freeze(PRIORITY.slice());
export const RULE_PRIORITY = PRIORITY;
