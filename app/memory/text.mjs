// Text utilities shared by storage, retrieval and extraction.
//
// Ported from `engine/fts5_memory.py` (the sanitizer that keeps punctuation out of
// FTS5 MATCH expressions) and `engine/memory_layer.py` (token overlap + cosine
// helpers), so the JS layer speaks the same tokenizer contract as the Python one.
import { createHash } from 'node:crypto';

const TOKEN_RE = /[A-Za-z0-9_가-힣]+/g;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** CJK/Hangul has no spaces: also emit syllable bigrams so partial Korean words match. */
export function tokens(text) {
  const raw = String(text ?? '').match(TOKEN_RE) ?? [];
  const out = [];
  for (const token of raw) {
    if (/[가-힣]+/.test(token)) {
      out.push(token);
      const syllables = token.match(/[가-힣]+/g) ?? [];
      for (const group of syllables) {
        for (let i = 0; i + 1 < group.length; i += 1) out.push(group.slice(i, i + 2));
      }
    }
    out.push(token.toLowerCase());
  }
  return out;
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function wordTokens(text) {
  return (String(text ?? '').match(WORD_RE) ?? []).map((word) => word.toLowerCase());
}

/**
 * Safe FTS5 MATCH expression. Every token is quoted and prefixed, so punctuation
 * (`def foo():`, `x->y`, `JSON["k"]`) can never become an operator and a partial
 * Korean word still matches its inflected form. The documented reason: an unsanitized
 * query raises `fts5: syntax error` instead of returning rows.
 */
export function sanitizeFts5Query(query, joiner = 'OR') {
  const raw = String(query ?? '').match(TOKEN_RE) ?? [];
  if (!raw.length) return '';
  const unique = [...new Set(raw.slice(0, 24))];
  const mode = ['OR', 'AND', 'NEAR'].includes(String(joiner).toUpperCase()) ? String(joiner).toUpperCase() : 'OR';
  return unique.map((token) => `"${token}"*`).join(` ${mode} `);
}

export function shingles(text, size = 3) {
  const normalized = normalizeText(text).replace(/[^\p{L}\p{N}_ ]/gu, ' ');
  const chars = Array.from(normalized.replace(/ /g, '_'));
  const keys = new Set();
  for (let i = 0; i + size <= chars.length; i += 1) keys.add(chars.slice(i, i + size).join(''));
  return keys;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** Stable identity used for exact-duplicate detection: type plus normalized wording. */
export function fingerprintOf({ type, title, body }) {
  const normalized = normalizeText(`${type} ${title} ${body}`).replace(/[^\p{L}\p{N}_ ]/gu, '');
  return sha256(normalized).slice(0, 32);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const value = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(-1, Math.min(1, value));
}

export function l2normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

const HASH_DIM = 256;

/**
 * Deterministic offline embedding: hashed character trigrams, L2 normalized.
 * It is lexical overlap wearing a vector's clothes, and is always reported under the
 * `local-hash-3gram-v1` model id so no caller mistakes it for semantics.
 */
export function hashEmbed(text) {
  const vector = new Float32Array(HASH_DIM);
  for (const key of shingles(String(text ?? ''), 3)) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % HASH_DIM;
    vector[bucket] += hash & 1 ? 1 : -1;
  }
  return l2normalize(Array.from(vector));
}

export function float32ToBlob(vector) {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function blobToFloat32(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Collapses whitespace and clips at a word boundary; used for bounded memory bodies. */
export function clip(text, maxChars = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  return `${boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut}…`;
}
