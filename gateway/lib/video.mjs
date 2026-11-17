import crypto from 'node:crypto';
import { GatewayError } from './errors.mjs';
import { readBody, requestUpstream, translateUpstreamFailure } from './upstream.mjs';

const STATES = new Set(['queued', 'running', 'succeeded', 'failed']);
const TERMINAL = new Set(['succeeded', 'failed']);

// Job records live in this process. Quota counters are on disk (lib/quota.mjs);
// job handles are not, so a restart forgets in-flight jobs. The README states
// that plainly rather than implying durability the gateway does not provide.
export class VideoJobs {
  constructor({ ttlMs = 3600000, clock = () => Date.now(), maxJobs = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
  }

  sweep() {
    const cutoff = this.clock() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt < cutoff) this.jobs.delete(id);
    }
    while (this.jobs.size > this.maxJobs) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  create({ identity, model, upstream, upstreamId, submission }) {
    this.sweep();
    const job = {
      id: `vid_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'video.job',
      identity,
      model,
      upstream: upstream.id,
      upstreamJobId: upstreamId,
      status: 'queued',
      progress: null,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      submission,
      artifact: null,
      error: null,
      completionCharged: false,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  // Only the identity that submitted a job may read it back. A job id is not a
  // capability: quota and content are per identity.
  owned(id, identity) {
    const job = this.get(id);
    if (!job) {
      throw new GatewayError(404, 'video_job_not_found',
        `no video job ${id} is known to this gateway; job handles are process-local and are lost on restart`,
        { type: 'invalid_request_error', param: 'id' });
    }
    if (job.identity !== identity) {
      throw new GatewayError(404, 'video_job_not_found',
        `no video job ${id} is known for identity ${identity}`,
        { type: 'invalid_request_error', param: 'id' });
    }
    return job;
  }

  applyUpstream(job, payload) {
    const rawStatus = typeof payload?.status === 'string' ? payload.status.toLowerCase() : null;
    const status = rawStatus && STATES.has(rawStatus) ? rawStatus : job.status;
    job.status = status;
    if (typeof payload?.progress === 'number' && Number.isFinite(payload.progress)) {
      job.progress = Math.max(0, Math.min(1, payload.progress));
    } else if (typeof payload?.progress === 'string' && payload.progress.trim()) {
      job.progress = payload.progress.trim().slice(0, 64);
    }
    if (status === 'succeeded') {
      const output = payload?.output;
      const reference = typeof output === 'string'
        ? output
        : output && typeof output === 'object'
          ? output.url || output.href || output.id || null
          : payload?.output_url || null;
      job.artifact = reference
        ? { url: String(reference), expires_at: payload?.expires_at ?? null }
        : null;
    }
    if (status === 'failed') {
      const message = payload?.error && typeof payload.error === 'object'
        ? payload.error.message
        : typeof payload?.error === 'string' ? payload.error : null;
      job.error = { message: message || 'upstream reported failure', code: 'upstream_failed' };
    }
    job.updatedAt = this.clock();
    return job;
  }

  isTerminal(job) {
    return TERMINAL.has(job.status);
  }

  toWire(job, basePath) {
    return {
      id: job.id,
      object: 'video.job',
      model: job.model,
      status: job.status,
      progress: job.progress,
      created_at: new Date(job.createdAt).toISOString(),
      upstream: job.upstream,
      upstream_job_id: job.upstreamJobId,
      artifact: job.artifact ? { ...job.artifact, content_url: job.artifact.url ? `${basePath}/${job.id}/content` : null } : null,
      error: job.error,
      quota_charged_on: 'submission and completion',
    };
  }
}

export function videoPollPath(template, upstreamId) {
  return template.replace('{id}', encodeURIComponent(upstreamId));
}

// Reads the upstream job state. A provider that answers with a body the gateway
// cannot read leaves the job in its last known state; it never crashes the
// poll and never invents a terminal state.
export async function pollUpstreamJob({ job, upstream, config, key }) {
  const path = videoPollPath(upstream.video.pollPath, job.upstreamJobId);
  let response;
  try {
    response = await requestUpstream({
      upstream,
      path,
      method: 'GET',
      timeoutMs: config.timeouts.videoMs,
      key: upstream.authMode === 'gateway_key' ? key : null,
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, 'upstream_unreachable',
      `video upstream ${upstream.id} is unreachable: ${error.message}`, { type: 'upstream_error' });
  }
  const text = await readBody(response.res);
  if (response.res.statusCode >= 400) {
    throw translateUpstreamFailure({ upstream, status: response.res.statusCode, text });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GatewayError(502, 'upstream_bad_response',
      `video upstream ${upstream.id} returned a body that is not JSON`,
      { type: 'upstream_error' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GatewayError(502, 'upstream_bad_response',
      `video upstream ${upstream.id} returned a body that is not a JSON object`,
      { type: 'upstream_error' });
  }
  return payload;
}
