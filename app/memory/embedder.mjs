// Lazy, self-releasing local embedder.
//
// CPU only: no GPU, no remote endpoint, no API key. The model lives in a sidecar
// child process (`embed-worker.mjs`) that is started on the first embedding request
// and terminates itself after an idle window, so a session that never searches keeps
// zero model memory resident. If the model cannot be loaded the client degrades to
// the deterministic `local-hash-3gram-v1` vectors and reports that honestly.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEmbed } from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'embed-worker.mjs');
export const HASH_MODEL = 'local-hash-3gram-v1';

export class EmbeddingClient {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.lastModel = null;
    this.degradedReason = null;
    this.starting = null;
    this.spawnFailures = 0;
  }

  env() {
    return {
      ...process.env,
      OMP_MEMORY_EMBED_MODEL: this.config.embedModel,
      OMP_MEMORY_MODELS_DIR: this.config.modelsDir,
      OMP_MEMORY_EMBED_IDLE_MS: String(this.config.embedIdleMs),
    };
  }

  async ensureChild() {
    if (this.child && !this.child.killed) return this.child;
    if (this.spawnFailures > 2) throw new Error('embedding sidecar repeatedly failed to start');
    const child = spawn(this.execPath(), ['--no-warnings', WORKER], {
      cwd: this.config.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.env(),
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.degradedReason = `embedding sidecar stderr: ${String(chunk).trim().slice(0, 200)}`;
    });
    child.once('error', () => {
      this.spawnFailures += 1;
      this.release();
    });
    child.once('exit', () => {
      this.child = null;
      for (const [, entry] of this.pending) entry.reject(new Error('embedding sidecar exited'));
      this.pending.clear();
    });
    this.starting = child;
    return child;
  }

  execPath() {
    // Bun and Node both run the worker; the worker resolves transformers itself.
    return process.execPath;
  }

  /** The runtime the current process is actually using, for reporting only. */
  runtime() {
    return typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.event === 'idle_exit') {
        this.child = null;
        continue;
      }
      const entry = this.pending.get(frame.id);
      if (!entry) continue;
      this.pending.delete(frame.id);
      if (!frame.ok) entry.reject(new Error(frame.error ?? 'embedding failed'));
      else entry.resolve(frame);
    }
  }

  async embed(texts, { kind = 'passage', timeoutMs = this.config.embedTimeoutMs } = {}) {
    if (!texts.length) return { model: this.lastModel ?? this.config.embedModel, dim: 0, vectors: [], degraded: false };
    try {
      const frame = await this.request({ method: 'embed', texts, kind }, timeoutMs);
      this.lastModel = frame.model;
      this.degradedReason = frame.degradedReason ?? null;
      return { model: frame.model, dim: frame.dim, vectors: frame.vectors, degraded: Boolean(frame.degradedReason) };
    } catch (error) {
      // Degradation, never a crash: keyword-only or hash-vector retrieval still works.
      this.degradedReason = error.message;
      this.release();
      return {
        model: HASH_MODEL,
        dim: 256,
        vectors: texts.map((text) => hashEmbed(text)),
        degraded: true,
        reason: error.message,
      };
    }
  }

  request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedding timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ensureChild()
        .then((child) => child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`))
        .catch((error) => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /** Explicit release: the host calls this on shutdown and the idle timer does it too. */
  release() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {}
  }

  status() {
    return {
      resident: Boolean(this.child),
      model: this.lastModel ?? this.config.embedModel,
      degraded: Boolean(this.degradedReason),
      reason: this.degradedReason,
      idleMs: this.config.embedIdleMs,
    };
  }
}
