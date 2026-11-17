// The last model + reasoning decision, retained in memory for the local app.
//
// A streaming completion relays provider bytes verbatim and reports the decision
// only in response headers, so a client that wants to label the model it was
// served — instead of showing "자동" — has nothing to read after the fact. This
// is that after-the-fact read: one small record per requesting identity and
// route, replaced by the next decision for the same identity and route.
//
// Bounded in both directions, because neither side is under this process's
// control:
//
//   * Entry count: a fixed capacity. A new identity must not be able to grow a
//     gateway's memory, so the identity+route decided least recently is dropped
//     when the capacity is reached, and a reader for it sees `null`, not a stale
//     record.
//   * Entry contents: identifiers and the reason strings the selection and grade
//     resolvers already produced. No message content, no prompt, no credentials,
//     no cache keys, no headers, no provider text — nothing that would need the
//     redactor to be safe in the first place (the caller redacts anyway).
//
// Nothing here is written anywhere: the existing quota ledger stays the only
// on-disk state, and a restarted process starts with no decisions recorded, which
// the read endpoint reports as `{ selection: null }` rather than inventing one.

export const SELECTION_RECORD_CAPACITY = 16;

// Identity tokens cannot contain NUL (see identity.mjs), so this separator keeps
// an identity and a route from ever colliding into one key.
const SEPARATOR = '\u0000';

function boundBudget(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function createSelectionRecord({ capacity = SELECTION_RECORD_CAPACITY, clock = () => new Date() } = {}) {
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : SELECTION_RECORD_CAPACITY;
  // Map iteration order is insertion order and an updated key is re-inserted, so
  // the first key is always the least recently decided identity+route.
  const records = new Map();
  let sequence = 0;

  function keyFor(identity, route) {
    return `${route}${SEPARATOR}${identity}`;
  }

  // Called only once a request has committed to this decision: a refusal (route
  // policy, validation, quota) never records anything.
  function record({ identity, route, capability = 'chat', entry, selection, reasoning, requestId = null }) {
    sequence += 1;
    const decided = clock();
    const decidedAt = decided instanceof Date && !Number.isNaN(decided.getTime())
      ? decided.toISOString()
      : null;
    const resolvedRole = selection.role ?? 'main';
    const primaryModel = selection.primary_model ?? entry.model.id;
    const fallbackChain = Array.isArray(selection.fallback_chain) && selection.fallback_chain.length > 0
      ? selection.fallback_chain
      : [entry.model.id];
    const value = Object.freeze({
      sequence,
      decided_at: decidedAt,
      capability,
      role: resolvedRole,
      route: selection.route ?? route,
      ...(typeof requestId === 'string' && requestId ? { request_id: requestId } : {}),
      model: Object.freeze({
        id: entry.model.id,
        upstream: entry.upstream.id,
        source: selection.source,
        reason: selection.reason,
        role: resolvedRole,
        role_reason: selection.role_reason ?? 'role:default_main',
        primary: primaryModel,
        fallback_chain: Object.freeze([...fallbackChain]),
        // Where the choice came from: the remote decision model, or the declared
        // local chain after that plane reported itself unreachable. Reason codes
        // are carried verbatim so the UI never has to paraphrase one.
        decision_source: selection.decision?.source ?? 'local',
        decision_reason: selection.decision?.reason ?? 'decision_plane_not_configured',
        decision_upstream: selection.decision?.upstream ?? null,
        decision_detail: selection.decision?.detail ?? null,
        decision_plane_available: selection.decision?.available ?? null,
      }),
      // The grade the gateway picked and the budget it sent with it. A decision
      // that sent no thinking parameter reports the grade as null and says why in
      // `reason`, rather than reporting a zero budget.
      reasoning: Object.freeze({
        source: reasoning.source ?? 'none',
        reason: reasoning.reason ?? 'auto:not_applicable',
        grade: reasoning.grade ?? null,
        thinking_budget: boundBudget(reasoning.thinking_budget),
      }),
    });
    const key = keyFor(identity, route);
    records.delete(key);
    records.set(key, value);
    while (records.size > limit) {
      const oldest = records.keys().next();
      if (oldest.done) break;
      records.delete(oldest.value);
    }
    return value;
  }

  function get(identity, route) {
    return records.get(keyFor(identity, route)) || null;
  }

  return { record, get, capacity: limit, size: () => records.size };
}
