// Reasoning controls are validated here rather than forwarded as free-form
// JSON. The gateway accepts exactly two spellings plus one effort enum, all
// bounded by the model's own declared thinking_limit, and refuses everything
// else before a reservation is taken or a socket is opened.
//
// Token accounting rule, stated once so it cannot drift: max_completion_tokens
// / max_tokens is the whole response budget and *includes* thinking tokens
// (the OpenAI-compatible reading). The reservation is therefore the larger of
// the completion budget and the thinking budget, never their sum: a 16-token
// completion limit with an 8193-token thinking budget reserves 8193, and a
// 16384 completion limit with an 8192 thinking budget reserves 16384.
//
// A model opts in by declaring thinking_limit in the config. A request that
// sends reasoning fields to a model without it is refused (400), not silently
// stripped: dropping a caller's explicit reasoning request would change the
// answer they get without telling them.

import { GatewayError } from './errors.mjs';

export const REASONING_EFFORT_VALUES = Object.freeze(['low', 'medium', 'high']);
export const THINKING_TYPES = Object.freeze(['enabled', 'disabled']);

const THINKING_OBJECT_KEYS = Object.freeze(['type', 'budget_tokens']);

function unsupported(param, message, detail) {
  return new GatewayError(400, 'unsupported_parameter', message,
    { type: 'invalid_request_error', param, detail });
}

function invalid(param, message, detail) {
  return new GatewayError(400, 'invalid_parameter', message,
    { type: 'invalid_request_error', param, detail });
}

function conflict(param, message, detail) {
  return new GatewayError(400, 'parameter_conflict', message,
    { type: 'invalid_request_error', param, detail });
}

function requirePositiveInteger(value, param, limit) {
  if (value === null || value === undefined) {
    throw invalid(param, `${param} must be a positive integer, got ${value === null ? 'null' : 'undefined'}`,
      { received: value === undefined ? 'undefined' : null });
  }
  if (typeof value === 'boolean' || typeof value !== 'number') {
    throw invalid(param, `${param} must be a positive integer, got ${typeof value}`,
      { received_type: typeof value });
  }
  if (!Number.isInteger(value)) {
    throw invalid(param, `${param} must be a whole number of tokens, got a fractional value`,
      { received: 'fractional' });
  }
  if (value <= 0) {
    throw invalid(param, `${param} must be greater than zero`, { received: value });
  }
  if (limit !== null && value > limit) {
    throw invalid(param,
      `${param} ${value} exceeds this model's thinking_limit of ${limit}; the gateway will not forward a budget the model was not declared to support`,
      { received: value, thinking_limit: limit });
  }
  return value;
}

function thinkingObject(value, limit) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('thinking', 'thinking must be an object with a type field', {
      received_type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    });
  }
  const unknown = Object.keys(value).filter((key) => !THINKING_OBJECT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw invalid('thinking', `thinking carries field(s) this gateway does not accept: ${unknown.join(', ')}`,
      { accepted_keys: [...THINKING_OBJECT_KEYS], received_keys: Object.keys(value) });
  }
  if (!THINKING_TYPES.includes(value.type)) {
    throw invalid('thinking.type', `thinking.type must be one of ${THINKING_TYPES.join(', ')}`,
      { received: typeof value.type === 'string' ? value.type : typeof value.type });
  }
  if (value.type === 'disabled') {
    if (Object.prototype.hasOwnProperty.call(value, 'budget_tokens')) {
      throw conflict('thinking.budget_tokens',
        'thinking.type is disabled but thinking.budget_tokens was provided; send one or the other',
        { thinking: { type: 'disabled', budget_tokens: value.budget_tokens } });
    }
    return { type: value.type, budget: null };
  }
  const budget = requirePositiveInteger(value.budget_tokens, 'thinking.budget_tokens', limit);
  return { type: value.type, budget };
}

// Returns the fields to merge into the upstream payload plus the token count
// the reservation must hold.
export function validateReasoning({ body, model }) {
  const hasEffort = Object.prototype.hasOwnProperty.call(body, 'reasoning_effort');
  const hasBudget = Object.prototype.hasOwnProperty.call(body, 'thinking_budget');
  const hasThinking = Object.prototype.hasOwnProperty.call(body, 'thinking');
  const fields = {};
  if (!hasEffort && !hasBudget && !hasThinking) return { fields, reserved: 0 };

  const isDecisionModel = Boolean(model?.metadata?.decision_model === true);
  const limit = model.thinkingLimit ?? null;

  // Decision models delegate reasoning to the remote decision model: the remote
  // chooses the concrete worker and reasoning depth per request.
  if (limit === null) {
    if (isDecisionModel) {
      if (hasEffort) {
        if (!REASONING_EFFORT_VALUES.includes(body.reasoning_effort)) {
          throw invalid('reasoning_effort',
            `reasoning_effort must be one of ${REASONING_EFFORT_VALUES.join(', ')}`,
            { received: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : typeof body.reasoning_effort });
        }
        fields.reasoning_effort = body.reasoning_effort;
      }
      if (hasBudget) {
        if (!Number.isInteger(body.thinking_budget) || body.thinking_budget <= 0) {
          throw invalid('thinking_budget', 'thinking_budget must be a positive integer',
            { thinking_budget: body.thinking_budget });
        }
        fields.thinking_budget = body.thinking_budget;
      }
      if (hasThinking) {
        const thinking = body.thinking;
        if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
          throw invalid('thinking', 'thinking must be an object', { thinking });
        }
        if (!THINKING_TYPES.includes(thinking.type)) {
          throw invalid('thinking.type', `thinking.type must be one of ${THINKING_TYPES.join(', ')}`,
            { received: typeof thinking.type === 'string' ? thinking.type : typeof thinking.type });
        }
        if (thinking.type === 'disabled') {
          if (hasBudget || hasEffort) {
            throw conflict('thinking',
              'thinking.type is disabled but the request also asks for a thinking budget or a reasoning effort; send one or the other',
              { thinking: { type: 'disabled' }, thinking_budget: hasBudget, reasoning_effort: hasEffort });
          }
          fields.thinking = { type: 'disabled' };
          return { fields, reserved: 0, delegated: true };
        }
        fields.thinking = { ...thinking };
      }
      const reserved = (fields.thinking_budget ?? fields.thinking?.budget_tokens ?? 2048);
      return { fields, reserved, delegated: true };
    }

    throw unsupported('thinking',
      `model ${model.id} does not declare reasoning support (no thinking_limit in its config), so reasoning_effort, thinking and thinking_budget cannot be forwarded to it; remove them or use a reasoning-capable model`,
      { model: model.id, reasoning_capable: false });
  }

  let effort = null;
  if (hasEffort) {
    if (!REASONING_EFFORT_VALUES.includes(body.reasoning_effort)) {
      throw invalid('reasoning_effort',
        `reasoning_effort must be one of ${REASONING_EFFORT_VALUES.join(', ')}`,
        { received: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : typeof body.reasoning_effort });
    }
    effort = body.reasoning_effort;
  }

  let flatBudget = null;
  if (hasBudget) flatBudget = requirePositiveInteger(body.thinking_budget, 'thinking_budget', limit);

  const thinking = hasThinking ? thinkingObject(body.thinking, limit) : null;
  if (thinking && thinking.type === 'disabled') {
    if (hasBudget || effort) {
      throw conflict('thinking',
        'thinking.type is disabled but the request also asks for a thinking budget or a reasoning effort; send one or the other',
        { thinking: { type: 'disabled' }, thinking_budget: hasBudget, reasoning_effort: effort });
    }
    fields.thinking = { type: 'disabled' };
    return { fields, reserved: 0 };
  }
  if (flatBudget !== null && thinking && thinking.budget !== null && flatBudget !== thinking.budget) {
    throw conflict('thinking_budget',
      `thinking_budget ${flatBudget} and thinking.budget_tokens ${thinking.budget} disagree; send one value`,
      { thinking_budget: flatBudget, thinking_budget_tokens: thinking.budget });
  }

  const budget = flatBudget ?? thinking?.budget ?? null;
  if (effort) fields.reasoning_effort = effort;
  if (flatBudget !== null) fields.thinking_budget = flatBudget;
  if (thinking) fields.thinking = { type: thinking.type, budget_tokens: budget };
  // An effort enum has no token number the gateway can trust, so the whole
  // declared ceiling is reserved rather than an invented figure.
  const reserved = budget ?? limit;
  return { fields, reserved };
}

// The completion half of the reservation, validated instead of coerced. The
// fields themselves are still forwarded by the normal allowlist, so this
// returns only the admitted upper bound.
export function completionBudget(body) {
  const hasMax = Object.prototype.hasOwnProperty.call(body, 'max_tokens');
  const hasCompletion = Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens');
  if (!hasMax && !hasCompletion) return null;
  const a = hasMax ? requirePositiveInteger(body.max_tokens, 'max_tokens', null) : null;
  const b = hasCompletion ? requirePositiveInteger(body.max_completion_tokens, 'max_completion_tokens', null) : null;
  if (a !== null && b !== null && a !== b) {
    throw conflict('max_tokens',
      `max_tokens ${a} and max_completion_tokens ${b} disagree; send one value`,
      { max_tokens: a, max_completion_tokens: b });
  }
  return b ?? a;
}
