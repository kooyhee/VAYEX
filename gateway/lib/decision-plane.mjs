// Reachability of the remote decision plane.
//
// A model that is resolved by a remote decision model (the `combo/*` ids whose
// provider picks a concrete worker per request) is only a real choice while that
// plane answers. The gateway must not claim a role was served by the remote
// decision model when the probe says it is down, and it must not fail silently
// either: the selection records which of the two happened.
//
// The probe is one cheap `GET {base}/models` with the upstream's own bearer key,
// bounded in time and cached for a TTL, because the selection path is
// synchronous. Nothing here is logged: the key never leaves this module and the
// snapshot carries identifiers, a boolean and a reason string only.
//
// `available` is `true` (the plane answered), `false` (it did not), or `null`
// (nothing has been probed yet). `null` is a real answer: it means no observation
// exists, and every caller reports it as such instead of assuming reachability.

export const DECISION_PLANE_TTL_MS = 30_000;
export const DECISION_PLANE_TIMEOUT_MS = 4_000;

const NOT_CONFIGURED = 'decision_plane_not_configured';
const UNCHECKED = 'decision_plane_unchecked';
const UNREACHABLE = 'decision_plane_unreachable';
const AUTH_FAILED = 'decision_plane_auth_failed';
const READY = 'decision_plane_ready';

function isoAt(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function createDecisionPlane({
  upstreamId = null,
  baseUrl = null,
  modelsPath = '/models',
  keyValue = null,
  ttlMs = DECISION_PLANE_TTL_MS,
  timeoutMs = DECISION_PLANE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const configured = Boolean(upstreamId && baseUrl);
  const url = configured
    ? `${baseUrl}${String(modelsPath).startsWith('/') ? modelsPath : `/${modelsPath}`}`
    : null;
  let observation = null;
  let pending = null;

  function snapshot() {
    if (!configured) {
      return {
        configured: false,
        upstream: null,
        available: null,
        checked_at: null,
        age_ms: null,
        reason: NOT_CONFIGURED,
        detail: null,
      };
    }
    const age = observation ? now() - observation.at : null;
    return {
      configured: true,
      upstream: upstreamId,
      available: observation ? observation.available : null,
      checked_at: observation ? isoAt(observation.at) : null,
      age_ms: age,
      reason: observation ? observation.reason : UNCHECKED,
      detail: observation ? observation.detail : null,
      timeout_ms: timeoutMs,
      cache_ttl_ms: ttlMs,
    };
  }

  async function probe() {
    const startedAt = now();
    let detail = null;
    try {
      const headers = keyValue ? { authorization: `Bearer ${keyValue}` } : {};
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        observation = { available: true, reason: READY, detail: `http_${response.status}`, at: now() };
        return snapshot();
      }
      const isAuthError = response.status === 401 || response.status === 403;
      observation = {
        available: false,
        reason: isAuthError ? AUTH_FAILED : `${UNREACHABLE}_status`,
        detail: `http_${response.status}`,
        at: now(),
      };
      return snapshot();
    } catch (error) {
      // A timeout, a refused connection and an abort all mean the same thing here:
      // nothing answered. The detail keeps a code, never a body or a credential.
      const code = error?.code || error?.name || 'error';
      detail = `probe_${code}_after_${Math.max(0, now() - startedAt)}ms`;
      observation = { available: false, reason: UNREACHABLE, detail, at: now() };
      return snapshot();
    }
  }

  // Cached, deduplicated probe. Concurrent callers share one round trip so a
  // burst of turns cannot turn into a burst of probes.
  async function check() {
    if (!configured) return snapshot();
    if (observation && now() - observation.at < ttlMs) return snapshot();
    if (pending) return pending;
    pending = probe().finally(() => { pending = null; });
    return pending;
  }

  return {
    upstream: upstreamId,
    configured,
    ttlMs,
    timeoutMs,
    snapshot,
    check,
    // Used by an embedding host that measured reachability itself.
    record(available, reason = null, detail = null) {
      if (!configured) return snapshot();
      observation = {
        available: available !== false,
        reason: reason || (available !== false ? READY : UNREACHABLE),
        detail,
        at: now(),
      };
      return snapshot();
    },
  };
}

// The snapshot a selection reports: the plane's own fields plus the two values the
// selection layer decides — whether a decision-model entry was preferred and why.
export function decisionPlaneSummary(plane) {
  const state = plane && typeof plane.snapshot === 'function' ? plane.snapshot() : null;
  if (!state || !state.configured) {
    return { source: 'local', reason: NOT_CONFIGURED, upstream: null, available: null, checked_at: null, detail: null };
  }
  return {
    source: 'remote',
    reason: state.reason,
    upstream: state.upstream,
    available: state.available,
    checked_at: state.checked_at,
    detail: state.detail,
  };
}
