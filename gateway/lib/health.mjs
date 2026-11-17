import { requestUpstream, readBody } from './upstream.mjs';
import { keyForUpstream } from './authz.mjs';

// Health is a real probe of every configured upstream, cached briefly per
// upstream. An entry older than the TTL is re-probed rather than reused, and one
// unreachable upstream makes the whole report unhealthy.
//
// GPU state is read from Ollama's own API where an upstream exposes it. nvidia-smi
// is deliberately never invoked: on the target host its kernel module and
// userspace driver disagree (NVML error 18), so a number from it would be a
// guess with authority. When the source does not say, the answer is "unknown".
export class HealthProbe {
  constructor({ config, logger, keys, clock = () => Date.now() }) {
    this.config = config;
    this.logger = logger;
    this.keys = keys;
    this.clock = clock;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async probeAll() {
    const results = await Promise.all(this.config.upstreams.map((upstream) => this.probe(upstream)));
    const unreachable = results.filter((item) => !item.reachable);
    return {
      ok: unreachable.length === 0,
      upstreams: results,
      unreachable: unreachable.map((item) => item.id),
    };
  }

  invalidate() {
    this.cache.clear();
  }

  async probe(upstream) {
    const cached = this.cache.get(upstream.id);
    if (cached && this.clock() - cached.at < this.config.health.cacheMs) {
      return { ...cached.value, cached: true };
    }
    const pending = this.inFlight.get(upstream.id);
    if (pending) return pending;
    const promise = this.probeOnce(upstream)
      .then((value) => {
        this.cache.set(upstream.id, { at: this.clock(), value });
        this.logger.info('upstream_probe', {
          upstream: upstream.id,
          upstream_class: upstream.class,
          upstream_kind: upstream.kind,
          reachable: value.reachable,
          status: value.status,
          loaded_models: Array.isArray(value.loaded_models) ? value.loaded_models.length : null,
          gpu_state: value.gpu.state,
          error: value.error,
        });
        return value;
      })
      .finally(() => this.inFlight.delete(upstream.id));
    this.inFlight.set(upstream.id, promise);
    return promise;
  }

  async probeOnce(upstream) {
    const started = this.clock();
    const gpu = { state: 'unknown', source: null, note: null };
    // A pass-through upstream has no key the gateway could use, so it is probed
    // anonymously. That answers whether the provider is up; it says nothing
    // about whether any particular client's key works, and the report says so.
    const credential = keyForUpstream(upstream, this.keys);
    try {
      const { res } = await requestUpstream({
        upstream,
        path: upstream.kind === 'ollama' ? upstream.paths.tags : upstream.paths.models,
        method: 'GET',
        timeoutMs: this.config.health.timeoutMs,
        key: credential,
        allowAnonymousPassThrough: true,
      });
      const body = await readBody(res, 4 * 1024 * 1024).catch(() => '');
      res.resume();
      const latency = this.clock() - started;

      if (res.statusCode === 401 || res.statusCode === 403) {
        // The host answered and refused the anonymous probe. Reachability is
        // proven; usability of a client key is not, and is not claimed.
        return {
          id: upstream.id,
          upstream_class: upstream.class,
          upstream_kind: upstream.kind,
          reachable: true,
          status: res.statusCode,
          latency_ms: latency,
          credential_state: upstream.authMode === 'pass_through'
            ? 'unverified (pass-through: the gateway has no client key at probe time)'
            : 'rejected (the configured gateway key was refused)',
          gpu: { ...gpu, note: 'upstream answered, but its credential was refused' },
          error: null,
        };
      }
      // Reaching the socket is not enough: a 5xx means the provider cannot
      // serve, so it is reported unreachable.
      if (res.statusCode >= 500) {
        return {
          id: upstream.id,
          upstream_class: upstream.class,
          upstream_kind: upstream.kind,
          reachable: false,
          status: res.statusCode,
          latency_ms: latency,
          gpu: { ...gpu, note: 'upstream did not answer successfully; residency cannot be read' },
          error: `probe returned HTTP ${res.statusCode}`,
        };
      }

      let loadedModels = null;
      let advertised = null;
      if (upstream.kind === 'ollama') {
        const listed = safeJson(body);
        if (listed && Array.isArray(listed.models)) advertised = listed.models.map((m) => m?.name).filter(Boolean);
        const ps = await this.probeOllamaResidency(upstream);
        loadedModels = ps.models;
        Object.assign(gpu, ps.gpu);
      }

      return {
        id: upstream.id,
        upstream_class: upstream.class,
        upstream_kind: upstream.kind,
        reachable: true,
        status: res.statusCode,
        latency_ms: latency,
        advertised_models: advertised,
        loaded_models: loadedModels,
        gpu,
        error: null,
      };
    } catch (error) {
      return {
        id: upstream.id,
        upstream_class: upstream.class,
        upstream_kind: upstream.kind,
        reachable: false,
        status: null,
        latency_ms: this.clock() - started,
        gpu: { ...gpu, note: 'upstream unreachable; residency cannot be read' },
        error: error.message,
      };
    }
  }

  // Ollama's /api/ps reports what is currently resident and, when the host can
  // see its GPU, per-model size_vram. The sum is a real residency figure; when
  // no model reports size_vram the GPU state stays unknown.
  async probeOllamaResidency(upstream) {
    let res;
    try {
      ({ res } = await requestUpstream({
        upstream,
        path: upstream.paths.ps,
        method: 'GET',
        timeoutMs: this.config.health.timeoutMs,
        key: keyForUpstream(upstream, this.keys),
      }));
    } catch (error) {
      return {
        models: null,
        gpu: { state: 'unknown', source: '/api/ps', note: `residency probe failed: ${error.message}` },
      };
    }
    const body = await readBody(res, 4 * 1024 * 1024).catch(() => '');
    res.resume();
    if (res.statusCode >= 400) {
      return {
        models: null,
        gpu: { state: 'unknown', source: '/api/ps', note: `residency probe returned HTTP ${res.statusCode}` },
      };
    }
    const parsed = safeJson(body);
    if (!parsed || !Array.isArray(parsed.models)) {
      return { models: null, gpu: { state: 'unknown', source: '/api/ps', note: 'residency probe was not a model list' } };
    }
    const models = parsed.models.map((m) => ({
      name: m?.name ?? null,
      size_bytes: Number.isFinite(m?.size) ? m.size : null,
      size_vram_bytes: Number.isFinite(m?.size_vram) ? m.size_vram : null,
      expires_at: m?.expires_at ?? null,
    }));
    const vram = models.filter((m) => Number.isFinite(m.size_vram_bytes));
    if (vram.length === 0) {
      return {
        models,
        gpu: {
          state: 'unknown',
          source: '/api/ps',
          note: 'no loaded model reported size_vram, so GPU residency is unknown; nvidia-smi is not used on this host',
        },
      };
    }
    return {
      models,
      gpu: {
        state: 'reported',
        source: '/api/ps (sum of size_vram)',
        loaded_model_count: models.length,
        vram_in_use_bytes: vram.reduce((sum, m) => sum + m.size_vram_bytes, 0),
        note: 'total VRAM capacity is not reported by /api/ps, so free VRAM is unknown',
      },
    };
  }
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

