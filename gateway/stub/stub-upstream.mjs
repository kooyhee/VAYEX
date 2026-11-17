// Stub OpenAI-compatible upstream. It is test instrumentation, not a provider:
// it answers exactly the shapes the gateway has to handle (SSE, JSON, images,
// async video jobs) and can be told to misbehave. No network beyond loopback.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROMPT_FAIL = 'FAIL_500';
const PROMPT_MALFORMED = 'MALFORMED';
const PROMPT_NO_USAGE = 'NO_USAGE';
const PROMPT_SLOW = 'SLOW';

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

function textOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
}

export function createStubUpstream({ jobs = new Map(), chunks = ['Hello', ' from', ' the', ' stub'] } = {}) {
  const requests = [];
  let holdResponse = null;

  function jobBody(job) {
    return {
      id: job.id,
      object: 'video.job',
      status: job.polls >= job.readyAfter ? 'succeeded' : job.polls >= 1 ? 'running' : 'queued',
      progress: Math.min(1, Number((job.polls / Math.max(1, job.readyAfter)).toFixed(3))),
      output: job.polls >= job.readyAfter
        ? { url: `stub://artifact/${job.id}`, duration_s: job.duration ?? 4 }
        : null,
    };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    const chunksIn = [];
    req.on('data', (c) => chunksIn.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunksIn).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      // /<upstream>/v1/<openai route> or /<upstream>/api/<ollama route>
      let route = parts.slice(1).join('/');
      if (route.startsWith('v1/')) route = route.slice(3);

      if (route === 'chat/completions' && req.method === 'POST') {
        requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, raw });
        if (holdResponse) {
          const proceed = () => handleChat(req, res, body);
          return holdResponse(proceed, { req, res, body });
        }
        return handleChat(req, res, body);
      }

      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, raw });

      if (route === 'models' && req.method === 'GET') {
        return json(res, 200, { object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      }

      // Ollama's own API surface, which the gateway probes for health and
      // residency instead of assuming a GPU is present.
      if (route === 'api/tags' && req.method === 'GET') {
        return json(res, 200, {
          models: [
            { name: 'qwen2.5:72b', size: 47400000000 },
            { name: 'qwen3:32b', size: 20200000000 },
            { name: 'qwen2.5:32b', size: 20100000000 },
            { name: 'qwen3-embedding:0.6b', size: 639000000 },
          ],
        });
      }
      if (route === 'api/ps' && req.method === 'GET') {
        const loaded = process.env.STUB_OLLAMA_OMIT_VRAM === '1'
          ? [{ name: 'qwen3:32b', size: 20200000000, expires_at: '2030-01-01T00:00:00Z' }]
          : [{ name: 'qwen3:32b', size: 20200000000, size_vram: 19500000000, expires_at: '2030-01-01T00:00:00Z' }];
        return json(res, 200, { models: loaded });
      }

      if (route === 'images/generations' && req.method === 'POST') {
        if (!body?.prompt) return json(res, 400, { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'bad_prompt' } });
        if (String(body.prompt).includes(PROMPT_FAIL)) {
          return json(res, 500, { error: { message: 'stub image backend exploded', type: 'server_error', code: 'stub_image_500' } });
        }
        return json(res, 200, {
          created: 1700000000,
          data: [{ b64_json: Buffer.from(`stub-image:${body.prompt}`).toString('base64') }],
          usage: { total_tokens: 12 },
        });
      }

      if (route === 'videos' && req.method === 'POST') {
        if (!body?.prompt) return json(res, 400, { error: { message: 'prompt is required', code: 'bad_prompt' } });
        const id = `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        jobs.set(id, { id, polls: 0, readyAfter: 2, duration: body.duration_s ?? body.duration ?? null });
        return json(res, 200, { id, status: 'queued', created_at: new Date().toISOString() });
      }

      const videoMatch = /^videos\/([^/]+)(\/content)?$/.exec(route);
      if (videoMatch) {
        const job = jobs.get(videoMatch[1]);
        if (!job) return json(res, 404, { error: { message: 'no such job', code: 'job_not_found' } });
        if (videoMatch[2]) {
          const bytes = Buffer.from(`stub-video-bytes:${job.id}`);
          res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) });
          return res.end(bytes);
        }
        job.polls += 1;
        return json(res, 200, jobBody(job));
      }

      return json(res, 404, { error: { message: `stub has no route ${req.method} ${url.pathname}`, code: 'stub_no_route' } });
    });
  });

  function handleChat(req, res, body) {
    const prompt = textOf(body);
    if (prompt.includes(PROMPT_FAIL)) {
      // A provider error exactly as a real provider sends it: status plus a
      // structured error body the gateway must relay rather than mask.
      return json(res, 429, {
        error: {
          message: 'stub upstream is rate limiting you',
          type: 'rate_limit_error',
          code: 'stub_rate_limited',
        },
      });
    }
    if (body?.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (prompt.includes(PROMPT_MALFORMED)) {
        res.write('data: {"choices": [{"delta": {"content": "partial"');
        res.write('\n\n');
        res.write('data: not-json-at-all\n\n');
        return res.end();
      }
      res.write(`data: ${JSON.stringify({ id: 'stub-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ id: 'stub-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`);
      }
      if (!prompt.includes(PROMPT_NO_USAGE)) {
        res.write(`data: ${JSON.stringify({ id: 'stub-1', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (prompt.includes(PROMPT_MALFORMED)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"id": "stub-2", "choices": [{"message": {"content": "unterminated');
    }
    const payload = {
      id: 'stub-completion-1',
      object: 'chat.completion',
      created: 1700000000,
      model: body?.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `stub reply to: ${prompt}` }, finish_reason: 'stop' }],
    };
    if (!prompt.includes(PROMPT_NO_USAGE)) payload.usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
    return json(res, 200, payload);
  }

  return {
    server,
    requests,
    jobs,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
    lastRequest(predicate = () => true) {
      return [...requests].reverse().find(predicate) || null;
    },
    hold(fn) {
      holdResponse = fn;
    },
    unhold() {
      holdResponse = null;
    },
    reset() {
      requests.length = 0;
      jobs.clear();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STUB_PORT || 8799);
  const stub = createStubUpstream();
  await stub.listen(port);
  process.stdout.write(`stub upstream listening on http://127.0.0.1:${port}\n`);
  process.stdout.write('base paths: /local/v1, /openrouter/v1, /a6api/v1, /direct/v1\n');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await stub.close();
      process.exit(0);
    });
  }
}
