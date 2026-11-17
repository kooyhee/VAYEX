// Embedding sidecar: a short-lived child process that owns the ONNX model.
//
// It is spawned only on the first embedding request and exits on its own after
// `MEMORY_EMBED_IDLE_MS` of inactivity, so no model stays resident between sessions
// and no tokenizer/ONNX state leaks into the host or the `omp` child process.
// Protocol is newline-delimited JSON on stdin/stdout:
//   in : { id, method: 'embed' | 'info' | 'shutdown', texts?, kind? }
//   out: { id, ok, model, dim, vectors?, error? }
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEmbed, l2normalize } from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TRANSFORMERS_ROOT = path.join(ROOT, '.omp-runtime', 'node_modules');

const MODEL = process.env.OMP_MEMORY_EMBED_MODEL || 'Xenova/multilingual-e5-small';
const CACHE_DIR = process.env.OMP_MEMORY_MODELS_DIR || path.join(HERE, 'data', 'models');
const IDLE_MS = Number(process.env.OMP_MEMORY_EMBED_IDLE_MS || 60_000);

let extractor = null;
let modelId = null;
let degradedReason = null;
let idleTimer = null;
let pending = 0;

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending > 0) return armIdle();
    process.stdout.write(`${JSON.stringify({ event: 'idle_exit' })}\n`, () => process.exit(0));
  }, IDLE_MS);
  idleTimer.unref?.();
}

async function loadModel() {
  if (extractor || degradedReason) return;
  // Explicit opt-in to the offline stand-in: used by tests and by an air-gapped run.
  if (MODEL === 'local-hash-3gram-v1') {
    degradedReason = 'configured offline embedder (local-hash-3gram-v1)';
    modelId = 'local-hash-3gram-v1';
    return;
  }
  try {
    const require = createRequire(path.join(TRANSFORMERS_ROOT, 'noop.cjs'));
    const mod = require('@huggingface/transformers');
    const { pipeline, env } = mod;
    env.cacheDir = CACHE_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    modelId = MODEL;
  } catch (error) {
    // No download, no disk cache or a broken ONNX runtime is a *degradation*, not a
    // crash: the caller gets a deterministic lexical vector and an honest model id.
    degradedReason = `embedding model unavailable: ${error.message}`;
    extractor = null;
    modelId = 'local-hash-3gram-v1';
  }
}

/** E5 expects `query:` / `passage:` prefixes; without them the similarity ranking degrades. */
function prefixFor(kind) {
  return kind === 'query' ? 'query: ' : 'passage: ';
}

async function embed(texts, kind = 'passage') {
  await loadModel();
  if (!extractor) {
    return { model: 'local-hash-3gram-v1', dim: 256, vectors: texts.map((text) => hashEmbed(text)), degradedReason };
  }
  const input = texts.map((text) => `${prefixFor(kind)}${text}`);
  const output = await extractor(input, { pooling: 'mean', normalize: true });
  const dim = output.dims[output.dims.length - 1];
  const flat = output.data;
  const vectors = [];
  for (let i = 0; i < texts.length; i += 1) {
    const slice = Array.from(flat.slice(i * dim, (i + 1) * dim));
    vectors.push(l2normalize(slice));
  }
  return { model: modelId, dim, vectors };
}

function reply(id, payload) {
  process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`);
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.method === 'shutdown') {
      reply(request.id, { ok: true, model: modelId ?? MODEL, degradedReason });
      process.exit(0);
    }
    if (request.method === 'info') {
      reply(request.id, { ok: true, model: modelId ?? MODEL, dim: extractor ? 384 : 256, degradedReason, ready: Boolean(extractor) });
      armIdle();
      continue;
    }
    pending += 1;
    embed(request.texts ?? [], request.kind)
      .then((result) => reply(request.id, { ok: true, ...result }))
      .catch((error) => reply(request.id, { ok: false, error: error.message }))
      .finally(() => {
        pending -= 1;
        armIdle();
      });
  }
});
process.stdin.on('end', () => process.exit(0));
armIdle();
