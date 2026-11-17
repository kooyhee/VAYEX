// Masking and restoration of a single string.
//
// The form of the pseudonym is decided by *where the span sits*: inside a string
// literal or a comment it is `[PERSON_1]`; in an unquoted code position it is
// `__PII_PERSON_1__`, because `[PERSON_1]` there is a syntax error and masked
// code has to keep compiling.

import { detectAll } from './detectors.mjs';
import { escapeLiteralPseudonyms, unescapeLiteralPseudonyms } from './vault.mjs';

const ZWSP = '\u200b';

/**
 * Lexical state at `position`: are we inside a string literal, a template, or a
 * comment? Codes with backticks and `${}` are handled; a missed case degrades to
 * the prose form, which is never a syntax error inside a literal and is a
 * recoverable failure outside it.
 */
export function quoteStateAt(text, position) {
  let quote = null;
  let comment = null;
  for (let index = 0; index < position; index += 1) {
    const char = text[index];
    if (comment) {
      if (comment === 'line' && char === '\n') comment = null;
      else if (comment === 'block' && char === '*' && text[index + 1] === '/') { comment = null; index += 1; }
      continue;
    }
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (quote === '`') {
        if (char === '`') quote = null;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') { comment = 'line'; index += 1; continue; }
    if (char === '/' && text[index + 1] === '*') { comment = 'block'; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
  }
  if (comment) return 'comment';
  if (quote) return 'string';
  return 'code';
}

// What makes a span "code" is not just being outside quotes: `phone 010-1234-5678`
// in a sentence is prose too. A span gets the identifier form only when it sits
// unquoted on a line that actually reads as code, or in a field that is code
// throughout — which is exactly the case where `[PERSON_1]` would not compile.
// Code position requires genuine language keywords, declarations, or statement operators —
// never just an isolated parenthesis in natural prose like "(주)회사" or "(12/28)".
const CODE_LINE = /\b(?:const|let|var|function|class|return|import|export|async|await|throw|new|interface|type)\b|=>|;\s*$|\{|\}|\brequire\b|\bconsole\./;
const CODE_FIELD = /^(?:[ \t]*(?:import|export|const|let|var|function|class|async|interface|type|#include|package)\s)|=>|^\s*[{[]/m;

/**
 * `prose` inside a string literal, a comment, or a line that reads as text;
 * `code` only where an identifier is the correct substitution.
 */
export function formForSpan(text, start, end) {
  const state = quoteStateAt(text, start);
  if (state !== 'code') return 'prose';
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const nextBreak = text.indexOf('\n', end);
  const line = text.slice(lineStart, nextBreak === -1 ? text.length : nextBreak);
  if (CODE_LINE.test(line)) return 'code';
  if (CODE_FIELD.test(text)) return 'code';
  return 'prose';
}

function placeholderForm(state) {
  return state === 'code' ? 'code' : 'prose';
}

/**
 * Where a credential span starts *as a value*: a span that also carries its own
 * assignment syntax (`password = "…"`, `api_key: "…"`) is replaced from its value,
 * not from its key.
 *
 * Detection spans the whole assignment on purpose — in a `.env` body the key is
 * part of the secret being taken off the wire. In code the same span is a
 * declaration, and replacing all of it deleted the initializer, so
 * `const password = "…";` became `const __PII_SECRET_1__;`, which is not the
 * program the user asked about. This module promises masked code still compiles, so
 * the key, the separator and the surrounding quotes stay and only the literal is
 * substituted.
 */
function valueBoundsInSpan(text, start, end) {
  const span = text.slice(start, end);
  const head = /^(?:export[ \t]+)?[A-Za-z_$][A-Za-z0-9_$.\-]{0,60}(?:[ \t]*\??[ \t]*:[^\n"'=]{0,40})?[ \t]*(?:=|:(?!=))[ \t]*(["'`])/.exec(span);
  if (!head) return { start, end };
  const quote = head[1];
  const valueStart = start + head[0].length;
  // When the closing quote is part of the span (`password = "…"`), keep it as syntax
  // just like the opening quote; otherwise an unclosed quote leaves `password = "[SECRET_1]`.
  const valueEnd = span.endsWith(quote) && end - valueStart > 0 ? end - 1 : end;
  return { start: valueStart, end: valueEnd };
}

/**
 * Mask one string, returning the masked text and every hit.
 * @param {string} text
 * @param {ReturnType<import('./vault.mjs').createVault>} vault
 * @param {{kind?:string, hint?:string}} [options]
 */
export function maskString(text, vault, { kind = 'text', hint = '' } = {}) {
  const source = String(text ?? '');
  if (!source) return { text: source, hits: [], findings: [] };
  // A literal `[PERSON_1]` the user typed is their text, not our pseudonym: break
  // it first so restoration can put it back byte for byte.
  const escaped = escapeLiteralPseudonyms(source);
  const findings = detectAll(escaped, { hint: hint || kind, path: '' });
  if (findings.length === 0) {
    // If no findings, undo literal escaping so zero-width spaces never leak into outgoing payload
    return { text: unescapeLiteralPseudonyms(escaped), hits: [], findings: [] };
  }
  let out = '';
  let cursor = 0;
  const hits = [];
  for (const finding of findings) {
    if (finding.start < cursor) continue;
    // The key, the separator and the quotes are syntax; the literal is the
    // credential. A placeholder keeps the assignment and takes only the literal's place.
    const { start: valueStart, end: valueEnd } = valueBoundsInSpan(escaped, finding.start, finding.end);
    out += escaped.slice(cursor, valueStart);
    const form = quoteStateAt(escaped, valueStart) === 'string' ? 'prose' : formForSpan(escaped, valueStart, valueEnd);
    const rawValue = unescapeLiteralPseudonyms(
      valueStart > finding.start || valueEnd < finding.end
        ? escaped.slice(valueStart, valueEnd)
        : finding.value,
    );
    const placeholder = vault.allocate(finding.rule, rawValue, { form, reserve: source });
    hits.push({ rule: finding.rule, class: finding.class, risk: finding.risk, form, placeholder, start: finding.start, end: finding.end });
    out += placeholder;
    cursor = valueEnd;
  }
  out += escaped.slice(cursor);
  return { text: out, hits, findings };
}

/** Longest-first replacement list for a vault, so `__PII_X_1__` beats `[X_1]`. */
export function replacementList(vault) {
  return [...vault.mapping.entries()].sort((a, b) => b[0].length - a[0].length);
}

/** Restore pseudonyms and undo literal escaping. Round-trip is exact. */
export function restoreString(text, vault) {
  const source = String(text ?? '');
  if (!source) return source;
  let out = source;
  for (const [placeholder, original] of replacementList(vault)) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(original);
  }
  return unescapeLiteralPseudonyms(out);
}

const CODE_FORM = /__PII_[A-Z]+_\d+__/;
const PROSE_FORM = /\[[A-Z]{3,8}_\d+(?:\.\d+)?\]/;

/**
 * Streaming restorer for SSE. It holds back a tail that could be the beginning of
 * a pseudonym, so a placeholder split across two chunks is still restored, and it
 * keeps that hold bounded by the longest key in the vault.
 */
export function createStreamRestorer(vault) {
  const keys = replacementList(vault).map(([placeholder]) => placeholder);
  if (keys.length === 0) {
    return {
      processChunk(chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        return text.includes(ZWSP) ? Buffer.from(text.split(ZWSP).join(''), 'utf8') : Buffer.from(text, 'utf8');
      },
      flush() { return Buffer.alloc(0); },
    };
  }
  const longest = keys.reduce((max, key) => Math.max(max, key.length), 0);
  let pending = '';

  function holdTail(text) {
    const limit = Math.min(longest - 1, text.length);
    for (let length = limit; length > 0; length -= 1) {
      const tail = text.slice(text.length - length);
      if (keys.some((key) => key.length > length && key.startsWith(tail))) return length;
    }
    return 0;
  }

  return {
    processChunk(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      const combined = pending + text;
      const complete = holdTail(combined);
      let head = combined.slice(0, combined.length - complete);
      pending = combined.slice(combined.length - complete);
      // Restore only complete placeholders; a held tail is never rewritten.
      for (const [placeholder, original] of replacementList(vault)) {
        if (head.includes(placeholder)) head = head.split(placeholder).join(original);
      }
      const cleaned = head.includes(ZWSP) ? head.split(ZWSP).join('') : head;
      return Buffer.from(cleaned, 'utf8');
    },
    flush() {
      if (!pending) return Buffer.alloc(0);
      const tail = restoreString(pending, vault);
      pending = '';
      return Buffer.from(tail, 'utf8');
    },
  };
}

export { CODE_FORM, PROSE_FORM };
