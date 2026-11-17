// Subword token cost, measured with the tokenizer that is actually installed.
//
// The credential heuristic needs to answer "is this string expensive to
// tokenize?", and the honest way to answer is the tokenizer this machine already
// has: `Xenova/multilingual-e5-small` (a SentencePiece *unigram* model with a
// 250k-entry vocabulary). Qwen weights are not installed, so guessing an
// efficiency figure for them would be invention — this module reports the model
// it actually used.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');

export const TOKENIZER_CANDIDATES = Object.freeze([
  join(PROJECT_ROOT, 'app', 'memory', 'data', 'models', 'Xenova', 'multilingual-e5-small', 'tokenizer.json'),
  join(PROJECT_ROOT, 'models', 'Xenova', 'multilingual-e5-small', 'tokenizer.json'),
  join(PROJECT_ROOT, 'engine', 'models', 'Xenova', 'multilingual-e5-small', 'tokenizer.json'),
]);

const MAX_PIECE = 16;
const UNKNOWN_PENALTY = 15;
let state = 'cold';
let vocab = null;
let vocabPath = null;

/** @returns {{state:string,path:string|null,entries:number,model:string}} */
export function tokenizerStatus() {
  return { state, path: vocabPath, entries: vocab ? vocab.size : 0, model: 'Xenova/multilingual-e5-small' };
}

/** Load the unigram vocabulary once. Never downloads anything. */
export function loadTokenizer() {
  if (state === 'ready') return true;
  if (state === 'unavailable') return false;
  for (const path of TOKENIZER_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, 'utf8'));
      const rows = json?.model?.vocab;
      if (!Array.isArray(rows)) continue;
      const map = new Map();
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number') map.set(row[0], row[1]);
      }
      if (map.size === 0) continue;
      vocab = map;
      vocabPath = path;
      state = 'ready';
      return true;
    } catch {
      state = 'unavailable';
    }
  }
  state = 'unavailable';
  vocabPath = null;
  return false;
}

/**
 * Deterministic subword approximation, used only when no vocabulary is readable.
 * Fixed character-class costs, so the same string always costs the same.
 */
export function approximateTokens(text) {
  const source = String(text ?? '');
  let tokens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 32 || code === 9 || code === 10) tokens += 0;
    else if (code >= 0xac00 && code <= 0xd7a3) tokens += 1;
    else if (code >= 0x30 && code <= 0x39) tokens += 0.5;
    else if (code >= 0x41 && code <= 0x5a) tokens += 0.5;
    else if (code >= 0x61 && code <= 0x7a) tokens += 0.5;
    else tokens += 1;
  }
  return Math.max(1, Math.round(tokens));
}

/** Viterbi segmentation over the unigram vocabulary: fewest-cost token path. */
function segment(text) {
  const marked = `\u2581${text.replace(/\s+/g, '\u2581')}`;
  const n = marked.length;
  const NEG = -1e9;
  const best = new Float64Array(n + 1).fill(NEG);
  const back = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 0; i < n; i += 1) {
    if (best[i] === NEG) continue;
    for (let len = 1; len <= MAX_PIECE && i + len <= n; len += 1) {
      const score = vocab.get(marked.slice(i, i + len));
      if (score === undefined) continue;
      const candidate = best[i] + score;
      if (candidate > best[i + len]) { best[i + len] = candidate; back[i + len] = len; }
    }
    // An unseen character still costs one token; the path never becomes empty.
    if (best[i + 1] < best[i] - UNKNOWN_PENALTY) { best[i + 1] = best[i] - UNKNOWN_PENALTY; back[i + 1] = 1; }
  }
  let count = 0;
  for (let at = n; at > 0 && count < n; count += 1) {
    const len = back[at];
    if (len <= 0) { count += at; break; }
    at -= len;
  }
  return Math.max(1, count);
}

/** Token count with the installed tokenizer, else the deterministic approximation. */
export function countTokens(text) {
  const source = String(text ?? '');
  if (!source) return 0;
  if (!loadTokenizer()) return approximateTokens(source);
  return segment(source);
}

/**
 * Characters per token. Ordinary prose lands around 3–5; a random base64/hex
 * credential tokenizes granularly and lands under 2.5, which is the signal the
 * credential heuristic uses.
 */
export function tokenEfficiency(text) {
  const source = String(text ?? '');
  if (!source) return 0;
  return source.length / countTokens(source);
}

/** Shannon entropy in bits per character. */
export function entropyBits(text) {
  const source = String(text ?? '');
  if (!source) return 0;
  const counts = new Map();
  for (const char of source) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / source.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
