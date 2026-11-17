// Automatic model selection.
//
// A request that omits `model` is served by a model this gateway picks from its
// own allowlist. Omission means the key is absent (or carries `undefined`, which
// JSON cannot express): a `null`, empty or non-string `model` was supplied and is
// still refused by name, exactly as before — the same "supplied versus absent"
// rule the route contract uses, so a value the gateway cannot read is never
// silently replaced.
//
// The pick is deterministic for identical inputs and never leaves the allowlist:
//
//   * Only entries whose model declaration includes the requested capability and
//     satisfies the route are candidates. `zdr_cloud` requires both
//     `zero_data_retention` and `training_opt_out` on the model itself; the
//     gateway has no other way to know, and it will not guess.
//   * Rules are tried in order and the first rule with at least one candidate
//     supplies the model. The rule that fired is the reported reason:
//       auto:server_local     a server_local upstream (the prompt stays on this host)
//       auto:zdr_declared     a model declaring both ZDR flags (any_cloud only,
//                             because on zdr_cloud every candidate already does)
//       auto:route_conforming any remaining route-conforming allowlisted model
//   * Inside a rule, candidates are ordered by: credential usable first (an
//     upstream whose key is missing, or a pass-through upstream the caller sent
//     no key for, cannot serve the request), then by declared context fit
//     (fits, unknown, does not fit), then by model id ascending. No randomness,
//     no clock, no request counter is involved.
//
// If no candidate remains, the answer is 503 `no_model_available_for_route` with
// the allowlist and the unmet requirement in the detail. The gateway never falls
// back to a model that does not satisfy the route.
//
// Token figures used for the context-fit ordering are estimates derived from the
// request itself (characters / 4, the usual English approximation). They only
// order candidates; they never refuse a request, and the response says
// `context_fit: null` when the catalogue declares no `context_window` for the
// chosen model rather than pretending the fit was checked.
//
// One request property can narrow the candidate set before the rules run: a
// caller who asked for actual reasoning and left the model open is served from
// the conforming models that declare `thinking_limit` and have a usable
// credential, when at least one exists. The response says
// `reasoning_required: true` when that happened, so the report never implies the
// route alone produced the pick. A `thinking: { type: 'disabled' }` request is
// not that: it asks for less work, not more, so it narrows nothing and stays on
// the local-first pick.
//
// Missing catalogue data degrades to a stated default, never to a guess: an
// undeclared `context_window` leaves the fit unchecked (`context_fit: null`) and
// is named in `assumptions`; an empty `assumptions` list means every input the
// decision needed was declared.

import { GatewayError } from './errors.mjs';
import { clientAuthorization, keyForUpstream } from './authz.mjs';
import { catalogueIds, enforceRoute, resolveModel } from './policy.mjs';
import { callerRequiresReasoning } from './grade.mjs';
import {
  AGENT_ROLES,
  MODEL_REGISTRY,
  ROLE_IDS,
  classifyAgentRole,
  evaluateModelCandidate,
  lookupModelRegistry,
  normalizeRole,
  planTurnExecution,
  resolveRoleModelChain,
} from './decision-planner.mjs';
import { validateTurnPlan } from './turn-plan.mjs';
import { costOf } from './accounting.mjs';
import { SESSION_PINS, segmentKey } from './session-pin.mjs';
import { emitEvent } from './events.mjs';

export {
  AGENT_ROLES,
  MODEL_REGISTRY,
  ROLE_IDS,
  classifyAgentRole,
  evaluateModelCandidate,
  lookupModelRegistry,
  normalizeRole,
  resolveRoleModelChain,
};

function pinsEnabled(config) {
  return config?.optimization?.pinSessions !== false;
}

export const AUTO_RULES = Object.freeze([
  Object.freeze({ reason: 'auto:server_local', test: (entry) => entry.upstream.class === 'server_local' }),
  Object.freeze({
    reason: 'auto:zdr_declared',
    test: (entry) => entry.model.zeroDataRetention === true && entry.model.trainingOptOut === true,
  }),
  Object.freeze({ reason: 'auto:route_conforming', test: () => true }),
]);

// Characters per token used by the estimate. Documented, not measured: this is
// an ordering aid, so a wrong estimate moves a candidate's rank, never an answer.
const CHARS_PER_TOKEN = 4;

const FIT_RANK = Object.freeze({ true: 0, null: 1, false: 2 });

export function hasExplicitModel(body) {
  if (!body || typeof body !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(body, 'model') && body.model !== undefined;
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (typeof part === 'string') total += part.length;
      else if (part && typeof part === 'object' && typeof part.text === 'string') total += part.text.length;
    }
    return total;
  }
  return 0;
}

export function estimatePromptTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  let chars = 0;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) chars += contentChars(message && message.content);
  }
  if (typeof body.prompt === 'string') chars += body.prompt.length;
  // Tool schemas are part of the prompt the provider receives.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    try {
      chars += JSON.stringify(body.tools).length;
    } catch {
      // An unserialisable tools field is not estimated; validateMessages and the
      // upstream receive it unchanged and the estimate simply stays low.
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function declaredOutputTokens(body) {
  if (!body || typeof body !== 'object') return null;
  const values = [body.max_completion_tokens, body.max_tokens]
    .filter((value) => Number.isInteger(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : null;
}

export function routeConforms(route, model) {
  if (route === 'zdr_cloud') return model.zeroDataRetention === true && model.trainingOptOut === true;
  return true;
}

function candidatesFor(config, capability) {
  if (capability === 'chat') return config.chatModels;
  if (capability === 'images') return config.imageModels;
  return config.videoModels;
}

function contextFit(model, neededTokens) {
  if (!Number.isInteger(model.contextWindow)) return null;
  return model.contextWindow >= neededTokens;
}

// A model that declares no context_window cannot have its fit checked. That is
// reported as `context_fit: null` and named here, rather than assumed to fit.
function fitAssumption(model) {
  return Number.isInteger(model.contextWindow) ? [] : ['context_window_not_declared'];
}

// The only reasoning-capability datum the catalogue carries is `thinking_limit`.
// A model that declares none has no known thinking support, and the gateway
// treats that as "no", never as "probably".
function declaresThinkingSupport(entry) {
  return Number.isInteger(entry.model.thinkingLimit) && entry.model.thinkingLimit > 0;
}

// Auth readiness of one upstream for this request, decided without opening a
// socket: no credential needed, or a usable gateway key, or a client Bearer the
// caller actually supplied to a pass-through upstream.
export function createServabilityCheck({ req, keys }) {
  const forwarded = clientAuthorization((req && req.headers) || {});
  return ({ upstream }) => {
    if (upstream.authMode === 'none') return true;
    if (upstream.authMode === 'gateway_key') {
      const key = keyForUpstream(upstream, keys);
      return Boolean(key && key.value && key.usable);
    }
    return Boolean(forwarded);
  };
}

function rank(candidates, neededTokens, isServable, pinnedModelId = null, roleChain = []) {
  const chainRank = (modelId) => {
    if (!Array.isArray(roleChain) || roleChain.length === 0) return Number.MAX_SAFE_INTEGER;
    const directIndex = roleChain.indexOf(modelId);
    if (directIndex !== -1) return directIndex;
    const reg = lookupModelRegistry(modelId);
    if (reg) {
      const canonicalIndex = roleChain.findIndex((cid) => {
        if (cid === reg.id) return true;
        const cReg = lookupModelRegistry(cid);
        return Boolean(cReg && cReg.id === reg.id);
      });
      if (canonicalIndex !== -1) return canonicalIndex;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return candidates
    .map((entry) => ({
      entry,
      servable: isServable(entry) ? 1 : 0,
      fit: contextFit(entry.model, neededTokens),
      pinned: (pinnedModelId && entry.model.id === pinnedModelId) ? 1 : 0,
      roleRank: chainRank(entry.model.id),
    }))
    .sort((a, b) => (b.servable - a.servable)
      || (b.pinned - a.pinned)
      || (a.roleRank - b.roleRank)
      || (FIT_RANK[String(a.fit)] - FIT_RANK[String(b.fit)])
      || (a.entry.model.id < b.entry.model.id ? -1 : a.entry.model.id > b.entry.model.id ? 1 : 0));
}

// Returns { entry: { model, upstream }, selection }. `selection` is what the
// response reports under `gateway.model` and in the x-gateway-model-* headers.
// The plan checks that need the chosen model: V-06 (is the pin in this allowlist),
// V-07 (is the grade a real grade this turn can send) and V-08 (does the priced
// estimate fit the configured cap). They cannot run before a model is chosen, so
// they run here against what the request is actually about to do.
export function enforcePlanAgainstModel({ plan, body, modelId, allowedModels, config }) {
  const needed = estimatePromptTokens(body) + (declaredOutputTokens(body) ?? 0);
  const anticipatedGrade = plan.tier === 'high_intelligence' ? 'high' : null;
  const estimateUsd = modelId && needed > 0 ? costOf(modelId, { input: needed, output: 0 }).usd : null;
  const budgetCapUsd = Number.isFinite(config?.optimization?.budgetCapUsd)
    ? config.optimization.budgetCapUsd : null;
  return validateTurnPlan(
    { ...plan, model: modelId, reasoning: anticipatedGrade },
    { allowedModels, estimateUsd, budgetCapUsd },
  );
}

export function selectModel({ route, capability, config, request, isServable = () => true, requireReasoning = false, session = null, role = null, decisionPlane = null }) {
  const allowlisted = candidatesFor(config, capability);
  const conforming = allowlisted.filter((entry) => routeConforms(route, entry.model));
  const requirement = route === 'zdr_cloud'
    ? { zero_data_retention: true, training_opt_out: true }
    : null;

  // A model whose concrete worker is resolved by the remote decision model is only
  // a choice while that plane answers. The probe result is a reported fact, never a
  // silent switch: when it says the plane is down, a decision entry is ineligible
  // and the role's declared local chain serves the request instead.
  const planeState = decisionPlane && typeof decisionPlane.snapshot === 'function' ? decisionPlane.snapshot() : null;
  const decisionGate = planeState ? { available: planeState.available ?? null } : null;
  const isDecisionEntry = (entry) => Boolean(entry?.model?.metadata?.decision_model === true);
  const gatedServable = (entry) => isServable(entry)
    && (!isDecisionEntry(entry) || decisionGate?.available !== false);
  const decisionModelsInAllowlist = conforming.filter(isDecisionEntry).map((entry) => entry.model.id);

  if (conforming.length === 0) {
    throw new GatewayError(503, 'no_model_available_for_route',
      `no model in this gateway's allowlist can serve ${capability} on route ${route}`
      + (requirement ? `: zdr_cloud requires a model declaring zero_data_retention and training_opt_out, and none does` : '')
      + '; the gateway will not pick a model that does not conform',
      {
        type: 'configuration_error',
        param: 'model',
        detail: {
          route,
          capability,
          allowlisted: catalogueIds(config, capability),
          required: requirement,
        },
      });
  }

  const estimate = estimatePromptTokens(request);
  const output = declaredOutputTokens(request);
  const needed = estimate + (output ?? 0);

  // 2-Track execution plan + 6-Role intent analysis. The recommendation is a
  // document, not an instruction: it passes the policy validator before anything
  // uses it, and the validator's clamps/violations are reported in the selection record.
  const latestPrompt = Array.isArray(request?.messages)
    ? (request.messages[request.messages.length - 1]?.content || '')
    : (typeof request?.prompt === 'string' ? request.prompt : '');
  const explicitRole = role ?? request?.role ?? request?.agent_role ?? request?.subagent_role ?? null;
  const recommendation = planTurnExecution(latestPrompt, request?.messages, {
    role: explicitRole,
    route,
    availableEntries: conforming,
    isServable: gatedServable,
    decisionGate,
  });
  const validated = validateTurnPlan({
    track: recommendation.track,
    reason: recommendation.reason,
    tier: recommendation.recommendedTier,
    thinkingBudget: recommendation.thinkingBudget,
    workers: recommendation.suggestedWorkers,
    planDirective: recommendation.planDirective,
    model: null,
    reasoning: null,
  }, { allowedModels: conforming.map((entry) => entry.model.id) });
  const plan = validated.plan;
  const resolvedRole = recommendation.role || 'main';
  const roleReason = recommendation.roleReason || 'role:default_main';
  const roleDef = AGENT_ROLES[resolvedRole] || AGENT_ROLES.main;
  const fallbackChain = Array.isArray(recommendation.fallbackChain) && recommendation.fallbackChain.length > 0
    ? recommendation.fallbackChain
    : (recommendation.fallbackBasis === 'local_fallback' ? [] : roleDef.candidates.slice());

  // The work-segment identity the pin is keyed on. `session` is the caller's own
  // conversation identity (the x-app-session header in the app), never a guess:
  // a request that names no session is not pinned at all. Subagent tasks with an
  // explicit subagent/segment identifier get their own segment pin so the main
  // session's KV cache tree is preserved.
  const sessionId = session || request?.session || request?.sessionId || request?.user || null;
  const explicitSegment = request?.segment || request?.subagent || null;
  const pinKey = segmentKey({ session: sessionId, route, capability, segment: explicitSegment });
  const pinning = pinsEnabled(config);
  let pinned = pinning && pinKey ? SESSION_PINS.get(pinKey) : null;
  if (pinned && pinned.stale) {
    SESSION_PINS.expire(pinKey, 'pin:ttl_expired_before_use');
    pinned = null;
  }
  const roleSwitchRequested = Boolean(explicitRole && pinned?.role && pinned.role !== resolvedRole);
  const pinnedModelId = (!roleSwitchRequested && pinned?.model) ? pinned.model : null;

  emitEvent('decision', {
    session: sessionId,
    role: resolvedRole,
    model: null,
    data: {
      track: plan.track,
      reason: plan.reason,
      tier: plan.tier,
      role: resolvedRole,
      role_reason: roleReason,
      primary_model: roleDef.primaryModel,
      fallback_chain: fallbackChain,
      workers: plan.workers,
      thinking_budget: plan.thinkingBudget,
      violations: validated.violations,
      assumptions: validated.assumptions,
    },
  });

  // A caller who asks for actual reasoning and leaves the model open is served by
  // a conforming model that declares thinking support when the allowlist has one
  // that can also be reached. Decision models delegate reasoning to the remote
  // decision model, so an automatic tier recommendation must not exclude them.
  const reasoningCapable = (entry) => (declaresThinkingSupport(entry) || isDecisionEntry(entry)) && gatedServable(entry);
  const askForReasoning = (requireReasoning && callerRequiresReasoning(request)) || recommendation.recommendedTier === 'high_intelligence';
  const reasoningEligible = askForReasoning && conforming.some(reasoningCapable)
    ? conforming.filter(reasoningCapable)
    : conforming;

  // When a specific role intent matched (or an explicit role was requested) on a
  // cloud-capable route and the session is not already pinned to a local model,
  // prefer servable models from the role's curated candidate list if present in the allowlist.
  const thinkingDisabled = Boolean(request?.thinking && typeof request.thinking === 'object' && request.thinking.type === 'disabled');
  const isRoleCandidate = (entry) => {
    if (!gatedServable(entry)) return false;
    const entryId = entry.model.id;
    if (roleDef.candidates.includes(entryId)) return true;
    const entryReg = lookupModelRegistry(entryId);
    return Boolean(entryReg && roleDef.candidates.some((cid) => {
      const cReg = lookupModelRegistry(cid);
      return cReg && cReg.id === entryReg.id;
    }));
  };
  // Cloud-capable routes route every request through the classified role's curated
  // candidate pool (including default `main` when intent did not match a specific sub-role),
  // provided the candidate list has servable models and the session is not pinned to a local model.
  const preferRolePool = route !== 'local_only'
    && !thinkingDisabled
    && (!pinnedModelId || roleDef.candidates.includes(pinnedModelId) || Boolean(lookupModelRegistry(pinnedModelId)))
    && reasoningEligible.some(isRoleCandidate);
  const eligible = preferRolePool
    ? reasoningEligible.filter(isRoleCandidate)
    : reasoningEligible;

  for (let index = 0; index < AUTO_RULES.length; index += 1) {
    const rule = AUTO_RULES[index];
    const matched = eligible.filter((entry) => rule.test(entry));
    if (matched.length === 0) continue;
    const fitting = matched.filter((entry) => contextFit(entry.model, needed) !== false);
    const pool = fitting.length > 0 ? fitting : (index === AUTO_RULES.length - 1 ? matched : []);
    if (pool.length === 0) continue;
    const [best] = rank(pool, needed, gatedServable, pinnedModelId, fallbackChain);

    // Where the choice actually came from. A decision entry means the remote
    // decision model picked the concrete worker; a non-decision entry while the
    // plane reported itself down means the declared local chain served it, and
    // that is reported rather than left for the caller to infer.
    const chosenIsDecision = isDecisionEntry(best.entry);
    const decisionSource = chosenIsDecision
      ? 'remote_decision'
      : (decisionModelsInAllowlist.length > 0 && decisionGate?.available === false ? 'local_fallback' : 'local');
    const planeReason = typeof planeState?.reason === 'string' ? planeState.reason : null;
    let decisionReason;
    if (decisionSource === 'remote_decision') {
      decisionReason = planeState?.available === null || planeState?.available === undefined
        ? 'decision_plane_unchecked'
        : 'decision_plane_ready';
    } else if (decisionSource === 'local_fallback') {
      decisionReason = planeReason && planeReason !== 'decision_plane_ready' ? planeReason : 'decision_plane_unreachable';
    } else if (route === 'local_only') {
      decisionReason = 'route_local_only';
    } else if (!planeState || !planeState.configured) {
      decisionReason = 'decision_plane_not_configured';
    } else {
      decisionReason = 'no_decision_model_available';
    }
    const decision = {
      source: decisionSource,
      reason: decisionReason,
      upstream: planeState?.configured ? planeState.upstream : null,
      available: planeState?.available ?? null,
      checked_at: planeState?.checked_at ?? null,
      detail: planeState?.detail ?? null,
    };
    // The chain the response reports is the one this request could actually take.
    // An empty declared chain — an allowlist that serves no local fallback — reports
    // the model that served the request instead of an id nothing could serve.
    const reportedChain = fallbackChain.length > 0 ? fallbackChain : [best.entry.model.id];

    if (sessionId && best?.entry?.model?.id) {
      if (pinning && pinKey) {
        SESSION_PINS.pin({
          key: pinKey,
          session: sessionId,
          model: best.entry.model.id,
          reasoning: pinned?.reasoning ?? null,
          capability,
          role: resolvedRole,
          reason: pinned ? 'pin:cache_tree_kept' : 'pin:first_turn',
        });
      }
    }

    const enforced = enforcePlanAgainstModel({
      plan,
      body: request,
      modelId: best.entry.model.id,
      allowedModels: conforming.map((candidate) => candidate.model.id),
      config,
    });
    const planViolations = [...validated.violations, ...enforced.violations];
    const servedPlan = enforced.plan;

    emitEvent('model.select', {
      session: sessionId,
      role: resolvedRole,
      model: best.entry.model.id,
      data: {
        role: resolvedRole,
        role_reason: roleReason,
        primary_model: roleDef.primaryModel,
        fallback_chain: reportedChain,
        tier: servedPlan.tier,
        reason: rule.reason,
        pinned: Boolean(pinnedModelId && best.entry.model.id === pinnedModelId),
        candidates: pool.length,
        considered: conforming.length,
        plan_track: servedPlan.track,
        decision_source: decision.source,
        decision_reason: decision.reason,
      },
    });

    return {
      entry: best.entry,
      selection: {
        source: 'gateway',
        reason: rule.reason,
        route,
        role: resolvedRole,
        role_reason: roleReason,
        primary_model: roleDef.primaryModel,
        fallback_chain: reportedChain,
        context_fit: best.fit,
        prompt_tokens_estimate: estimate,
        candidates: pool.length,
        considered: conforming.length,
        assumptions: fitAssumption(best.entry.model),
        reasoning_required: chosenIsDecision ? false : (reasoningEligible !== conforming),
        plan_mode: servedPlan.track,
        plan_reason: plan.reason,
        plan_tier: servedPlan.tier,
        plan_thinking_budget: servedPlan.thinkingBudget,
        plan_workers: servedPlan.workers,
        plan_directive: servedPlan.planDirective,
        plan_violations: planViolations,
        session_pinned: Boolean(pinnedModelId && best.entry.model.id === pinnedModelId),
        reasoning_pinned: pinned?.reasoning ?? null,
        decision,
      },
    };
  }

  // Unreachable: AUTO_RULES ends with a rule that accepts every candidate.
  throw new GatewayError(503, 'no_model_available_for_route',
    `no model in this gateway's allowlist can serve ${capability} on route ${route}`,
    { type: 'configuration_error', param: 'model', detail: { route, capability } });
}

// The single decision point used by every endpoint that used to demand `model`.
// An explicit model is resolved exactly as before and reported as the caller's
// own choice; it is never overridden.
export function resolveRequestModel(args) {
  return resolveRequestModelWithPolicy(args, enforceRoute);
}

// Embedders supply their own host boundary while reusing the same selector.
export function resolveRequestModelWithPolicy({ body, route, capability, config, isServable = () => true, requireReasoning = false, session = null, role = null, decisionPlane = null }, routePolicy) {
  const estimate = estimatePromptTokens(body);
  const needed = estimate + (declaredOutputTokens(body) ?? 0);
  const planeState = decisionPlane && typeof decisionPlane.snapshot === 'function' ? decisionPlane.snapshot() : null;
  if (hasExplicitModel(body)) {
    const entry = resolveModel({ modelId: body.model, config, capability });
    const latestPrompt = Array.isArray(body?.messages)
      ? (body.messages[body.messages.length - 1]?.content || '')
      : (typeof body?.prompt === 'string' ? body.prompt : '');
    const roleInfo = classifyAgentRole(latestPrompt, body?.messages, {
      role: role ?? body?.role ?? body?.agent_role ?? null,
    });
    const roleChain = resolveRoleModelChain(roleInfo.role, { route });
    return {
      entry,
      selection: {
        source: 'caller',
        reason: 'caller_explicit',
        route,
        role: roleInfo.role,
        role_reason: roleInfo.reason,
        primary_model: roleChain.primaryModel,
        fallback_chain: roleChain.fallbackChain,
        context_fit: contextFit(entry.model, needed),
        prompt_tokens_estimate: estimate,
        candidates: null,
        considered: null,
        assumptions: fitAssumption(entry.model),
        reasoning_required: false,
        // The caller named the model, so nothing decided anything on their behalf.
        decision: {
          source: 'caller',
          reason: 'caller_explicit',
          upstream: planeState?.configured ? planeState.upstream : null,
          available: planeState?.available ?? null,
          checked_at: planeState?.checked_at ?? null,
        },
      },
    };
  }
  // A local_only request is refused before a model is needed, and the refusal
  // must keep its existing code rather than becoming "no model available".
  if (route === 'local_only') routePolicy({ route, entry: null, capability });
  return selectModel({ route, capability, config, request: body, isServable, requireReasoning, session, role, decisionPlane });
}

// Everything the response states about who chose what. `source` is the field that
// keeps the two cases apart: `caller` means the request named it, `gateway` means
// the gateway did, `none` (reasoning only) means nothing was sent.
// `assumptions` lists the catalogue facts the decision needed and the config does
// not carry; an empty list means every input was declared.
export function selectionReport({ entry, selection, reasoning = NO_REASONING }) {
  return {
    model: {
      id: entry.model.id,
      upstream: entry.upstream.id,
      route: selection.route,
      source: selection.source,
      reason: selection.reason,
      role: selection.role ?? 'main',
      role_reason: selection.role_reason ?? 'role:default_main',
      primary_model: selection.primary_model ?? entry.model.id,
      fallback_chain: [...(selection.fallback_chain || [entry.model.id])],
      // Where this choice came from, in the same words the headers and the local
      // app's decision record use. `remote_decision` means the remote decision
      // model resolved the concrete worker; `local_fallback` means the plane was
      // unreachable and the role's declared local chain served the request.
      decision_source: selection.decision?.source ?? 'local',
      decision_reason: selection.decision?.reason ?? 'decision_plane_not_configured',
      decision_upstream: selection.decision?.upstream ?? null,
      decision_plane: {
        available: selection.decision?.available ?? null,
        checked_at: selection.decision?.checked_at ?? null,
        detail: selection.decision?.detail ?? null,
      },
      context_fit: selection.context_fit ?? null,
      prompt_tokens_estimate: selection.prompt_tokens_estimate ?? null,
      candidates_considered: selection.considered ?? null,
      candidate_pool: selection.candidates ?? null,
      reasoning_required: selection.reasoning_required ?? false,
      // The optimisations in force for this turn, reported so a reader never has
      // to infer them from headers or logs.
      plan_mode: selection.plan_mode ?? 'direct_execute',
      plan_tier: selection.plan_tier ?? 'fast',
      plan_reason: selection.plan_reason ?? null,
      plan_workers: selection.plan_workers ?? 1,
      plan_violations: (selection.plan_violations ?? []).map((violation) => ({ rule: violation.rule, action: violation.action })),
      session_pinned: selection.session_pinned ?? false,
      reasoning_pinned: selection.reasoning_pinned ?? null,
      assumptions: [...(selection.assumptions || [])],
    },
    reasoning,
  };
}

// Reasoning is not a chat-only concept in the response contract, but a model
// serving images or video has no thinking parameter at all, so those endpoints
// report this instead of inventing one.
export const NO_REASONING = Object.freeze({
  source: 'none',
  reason: 'auto:not_applicable',
  grade: null,
  reasoning_effort: null,
  thinking_budget: null,
  supported_grades: Object.freeze([]),
  supported_grades_basis: 'not_applicable',
  assumptions: Object.freeze([]),
  factors: null,
});

// The same facts as headers, which is the only place a streaming client can read
// them: the SSE relay forwards provider bytes verbatim, so nothing is injected
// into the stream.
export function selectionHeaders({ entry, selection, reasoning = NO_REASONING }) {
  const modelAssumptions = selection.assumptions || [];
  const reasoningAssumptions = reasoning.assumptions || [];
  const fallbackList = Array.isArray(selection.fallback_chain) && selection.fallback_chain.length > 0
    ? selection.fallback_chain.join(',')
    : entry.model.id;
  return {
    'x-gateway-role': selection.role || 'main',
    'x-gateway-role-reason': selection.role_reason || 'role:default_main',
    'x-gateway-model': entry.model.id,
    'x-gateway-model-primary': selection.primary_model || entry.model.id,
    'x-gateway-model-fallback': fallbackList,
    'x-gateway-upstream': entry.upstream.id,
    'x-gateway-model-source': selection.source,
    'x-gateway-model-reason': selection.reason,
    'x-gateway-model-route': selection.route,
    'x-gateway-decision-source': selection.decision?.source ?? 'local',
    'x-gateway-decision-reason': selection.decision?.reason ?? 'decision_plane_not_configured',
    'x-gateway-decision-upstream': selection.decision?.upstream ?? 'none',
    'x-gateway-decision-plane': selection.decision?.available === true
      ? 'true' : selection.decision?.available === false ? 'false' : 'unknown',
    // Named, never silent: a header a streaming caller can also read.
    'x-gateway-model-assumptions': modelAssumptions.length > 0 ? modelAssumptions.join(',') : 'none',
    'x-gateway-model-reasoning-required': selection.reasoning_required ? 'true' : 'false',
    'x-gateway-plan-mode': selection.plan_mode || 'direct_execute',
    'x-gateway-plan-tier': selection.plan_tier || 'fast',
    'x-gateway-plan-violations': (selection.plan_violations || []).length > 0
      ? selection.plan_violations.map((violation) => violation.rule).join(',') : 'none',
    'x-gateway-session-pinned': selection.session_pinned ? 'true' : 'false',
    'x-gateway-reasoning-pinned': selection.reasoning_pinned || 'none',
    'x-gateway-reasoning-grade': reasoning.grade ?? 'none',
    'x-gateway-reasoning-source': reasoning.source,
    'x-gateway-reasoning-reason': reasoning.reason,
    'x-gateway-reasoning-assumptions': reasoningAssumptions.length > 0 ? reasoningAssumptions.join(',') : 'none',
    'x-gateway-thinking-budget': reasoning.thinking_budget === null || reasoning.thinking_budget === undefined
      ? 'none' : String(reasoning.thinking_budget),
  };
}

// Records the model and reasoning grade a turn actually ran with, so the next
// turn of the same work segment reuses them instead of re-deciding. Called by the
// chat handler after the grade is settled (the handler is the only place that
// knows the grade that was sent).
export function pinTurn({ session, route, capability = 'chat', segment = null, model, reasoning = null, role = null, config = null }) {
  if (!pinsEnabled(config) || !session || !model) return null;
  const key = segmentKey({ session, route, capability, segment });
  if (!key) return null;
  const existing = SESSION_PINS.get(key);
  if (existing && existing.model === model && (!role || existing.role === role)) {
    const active = SESSION_PINS.noteActivity(key);
    if ((reasoning === null || existing.reasoning === null || existing.reasoning === reasoning)) return active;
  }
  return SESSION_PINS.pin({ key, session, model, reasoning, capability, role, reason: existing ? 'pin:grade_refined' : 'pin:first_turn' });
}

