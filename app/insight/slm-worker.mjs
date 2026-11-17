// Persistent inference process for the `local-model` tier.
//
// `@huggingface/transformers` runs ONNX inference on the calling thread; a 0.5B
// model takes 2–8 s of CPU per slice, and while it runs the Node.js event loop of
// the process that started it is frozen — timers, sockets, RPC frames and the app
// server's own request handling all stall. This file is forked by
// `local-model.mjs` so that inference happens in a different OS process and the
// parent loop only ever exchanges JSON over the IPC channel.
//
// Protocol (the parent always sends `runner`, `modelPath`, `dtype`):
//   → { id, runner, modelPath, dtype, messagesOrPrompt, options }
//   ← { id, ok: true, output }  |  { id, ok: false, error: { message, code, name } }
//
// Nothing is downloaded here: `allowRemoteModels = false` and the weights are the
// local directory the probe already found.

import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';

// No lowered OS priority: the child already keeps inference off the parent's loop,
// and a below-normal child starved to a 110 s title generation while the recorder
// held the machine (measured on the demo take), which outlived every request budget.

const runtimeCache = new Map();
const pipelineCache = new Map();

function loadRuntime(runner) {
  if (!runtimeCache.has(runner)) {
    // Resolve the transformers.js runtime from the directory the probe found, the
    // same way the in-process path does — but this module runs in the child, so the
    // inference it starts can never hold the parent's heap or its event loop.
    const require = createRequire(join(runner, 'noop.cjs'));
    const runtime = require('@huggingface/transformers');
    runtime.env.allowRemoteModels = false;
    runtime.env.allowLocalModels = true;
    runtimeCache.set(runner, runtime);
  }
  return runtimeCache.get(runner);
}

function loadPipeline({ runner, modelPath, dtype }) {
  const key = `${runner}::${modelPath}::${dtype}`;
  const cached = pipelineCache.get(key);
  if (cached) return cached;
  const intraOpNumThreads = Math.max(1, Math.min(4, Math.floor(cpus().length / 2) || 1));
  const promise = Promise.resolve(loadRuntime(runner).pipeline('text-generation', modelPath, {
    dtype,
    session_options: { intraOpNumThreads },
  }))
    .then((generate) => generate)
    .catch((error) => {
      pipelineCache.delete(key);
      throw error;
    });
  pipelineCache.set(key, promise);
  return promise;
}

function deliver(message) {
  try {
    process.send(message);
  } catch {
    // The parent is already gone; the `disconnect` handler below ends this process.
  }
}

function describeError(error) {
  return {
    name: String(error?.name ?? 'Error'),
    code: String(error?.code ?? 'worker_error'),
    message: String(error?.message ?? error),
  };
}

async function serve(request) {
  if (typeof request.runner !== 'string' || !request.runner) throw new Error('slm worker request carries no runtime path');
  if (typeof request.modelPath !== 'string' || !request.modelPath) throw new Error('slm worker request carries no model path');
  const generate = await loadPipeline(request);
  return generate(request.messagesOrPrompt, request.options ?? {});
}

// One generation at a time: the pipeline keeps one decoder state, so a second
// request would only interleave inside this single-threaded process.
let queue = Promise.resolve();

function handle(request) {
  if (!request || typeof request !== 'object') return;
  const id = request.id;
  queue = queue.then(async () => {
    try {
      deliver({ id, ok: true, output: await serve(request) });
    } catch (error) {
      deliver({ id, ok: false, error: describeError(error) });
    }
  });
}

process.on('message', handle);

// The parent's channel closing is the only shutdown signal that matters: a worker
// must never outlive the server or the test runner that forked it.
process.on('disconnect', () => {
  process.exit(0);
});

if (!process.connected) {
  // Started by hand instead of forked: this file has no request to serve and must
  // not sit around holding a pipeline.
  console.error('slm-worker.mjs is spawned by app/insight/local-model.mjs over IPC; it is not a CLI.');
  process.exit(2);
}
