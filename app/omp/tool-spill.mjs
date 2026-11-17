// Lossless spill store for bounded tool output.
//
// Compression is only acceptable if the original survives: every result the
// platform compresses is written here first, in full, on disk, and the notice the
// model sees carries the handle. 20 KB is the documented threshold — above it the
// inline copy is bounded and the artifact is the only complete original; below it
// nothing is spilled and the output is already whole.
//
// Handle format: `spill://<id>` where <id> is stable, unique per spill and
// recorded in a `.json` sidecar (`{ id, tool, bytes, path, createdAt, task }`).
// Recovery is a read of that file: no model, no network, no re-generation, so
// `recover` can never return a lossy summary of what the original said.
//
// This store issues exactly one scheme. omp's own artifacts use `artifact://<n>`
// and are resolved by the runtime's read tool, not here; a handle of that shape
// is therefore refused instead of being looked up in the wrong store.
// `tool_output_recover` (RECOVER_TOOL, registered by bounded-tool-result.js) is
// the tool that resolves these handles, and `recover` is the path it calls.
//
// The store is root-scoped so the orchestrator, the omp extension and tests each
// get their own directory, and `prune` keeps a bounded number of artifacts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPILL_THRESHOLD_BYTES = 20 * 1024;
export const SPILL_HANDLE_PREFIX = 'spill://';

export function defaultSpillRoot(env = process.env) {
  return env.AI_TOOL_SPILL_DIR || path.join(os.tmpdir(), 'ai-platform-tool-spill');
}

// The single authority for what a spill handle looks like. Issue (:spill), notice
// and resolve (:recover) all go through this, so neither side can drift to another
// scheme. A bare id is accepted because the notice prints the prefixed form and a
// model may echo only the id; anything carrying another scheme is rejected.
export function parseSpillHandle(handle) {
  const raw = typeof handle === 'string' ? handle.trim() : '';
  if (raw.length === 0) throw new Error('recover needs a spill handle');
  if (raw.startsWith(SPILL_HANDLE_PREFIX)) {
    const id = raw.slice(SPILL_HANDLE_PREFIX.length);
    if (!id) throw new Error(`recover needs a spill handle, got ${JSON.stringify(handle)}`);
    return id;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`${JSON.stringify(raw)} is not a ${SPILL_HANDLE_PREFIX} handle; this store issues only spill:// handles (artifact:// belongs to the runtime read tool)`);
  }
  return raw;
}

function safeName(text) {
  return String(text ?? 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

export function createSpillStore({ root = defaultSpillRoot(), now = () => Date.now(), maxArtifacts = 200 } = {}) {
  let counter = 0;
  fs.mkdirSync(root, { recursive: true });

  function files() {
    try {
      return fs.readdirSync(root).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
  }

  function metaFor(id) {
    const file = path.join(root, `${safeName(id)}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  const store = {
    root,
    thresholdBytes: SPILL_THRESHOLD_BYTES,
    // Writes the complete original and returns the handle the notice advertises.
    spill({ text, tool = 'tool', task = null }) {
      if (typeof text !== 'string') throw new Error('spill needs the original text');
      counter += 1;
      const id = `${now()}-${process.pid}-${counter}-${safeName(tool)}`;
      const bodyPath = path.join(root, `${id}.txt`);
      const metaPath = path.join(root, `${id}.json`);
      fs.writeFileSync(bodyPath, text, 'utf8');
      const bytes = fs.statSync(bodyPath).size;
      const expected = Buffer.byteLength(text, 'utf8');
      if (bytes !== expected) throw new Error(`short write: ${bytes} of ${expected} bytes`);
      const meta = { id, tool, bytes, path: bodyPath, createdAt: now(), task };
      fs.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, 'utf8');
      store.prune();
      return { handle: `${SPILL_HANDLE_PREFIX}${id}`, id, path: bodyPath, bytes, meta };
    },
    // Complete original, byte-for-byte. A missing artifact throws rather than
    // returning a truncated or synthesised stand-in.
    recover(handle) {
      const id = parseSpillHandle(handle);
      const meta = metaFor(id);
      if (!meta) throw new Error(`no spill artifact for handle ${handle}`);
      const text = fs.readFileSync(meta.path, 'utf8');
      return { ...meta, text, handle: `${SPILL_HANDLE_PREFIX}${id}` };
    },
    list() {
      return files().map((name) => metaFor(name.slice(0, -5))).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    },
    // Keeps the newest `maxArtifacts`; the oldest are removed body + sidecar.
    prune() {
      const all = store.list();
      const excess = all.slice(maxArtifacts);
      for (const meta of excess) {
        try {
          fs.rmSync(meta.path, { force: true });
          fs.rmSync(path.join(root, `${meta.id}.json`), { force: true });
        } catch {
          // A prune that cannot delete is not a reason to fail the turn.
        }
      }
      return excess.length;
    },
  };
  return store;
}

// The tool the model uses to ask for the original again. Advertised as a schema so
// a caller can register it with whatever tool registry it owns.
export const RECOVER_TOOL = Object.freeze({
  name: 'tool_output_recover',
  description: 'Return the complete original output behind a spill:// handle. Use when a compressed tool result omitted the line you need.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      handle: { type: 'string', description: 'spill:// handle printed in the truncation notice' },
      offset: { type: 'integer', description: 'optional 1-based starting line' },
      limit: { type: 'integer', description: 'optional maximum number of lines' },
    }),
    required: Object.freeze(['handle']),
  }),
});

export function recoverToolOutput(store, { handle, offset = null, limit = null } = {}) {
  const artifact = store.recover(handle);
  if (offset === null && limit === null) return { ...artifact, handle: artifact.handle };
  const lines = artifact.text.split('\n');
  const start = Math.max(0, (Number.isInteger(offset) ? offset : 1) - 1);
  const end = Number.isInteger(limit) && limit > 0 ? start + limit : lines.length;
  return {
    ...artifact,
    handle: artifact.handle,
    text: lines.slice(start, end).join('\n'),
    totalLines: lines.length,
    window: { start: start + 1, end: Math.min(end, lines.length) },
  };
}
