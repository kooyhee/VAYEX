// Automatic reasoning grade.
//
// The gateway picks a grade per request from properties of the request itself —
// prompt size, requested output length, tool use and route — and emits it with
// the model's own declared `thinking_limit` as the bound. The grade set is the
// one reasoning.mjs already validates: `reasoning_effort` low | medium | high.
//
// What "supported" means here, stated without inventing anything: the only
// reasoning-capability datum the config carries is `thinking_limit`. A model
// that declares none gets no thinking parameter at all — not a zero budget, not
// an effort the provider may reject, nothing — and the response says so. A model
// that declares a limit supports every grade whose base budget fits inside it;
// `low` is always available, clamped to the declared limit. The grade actually
// sent is never outside the enum, and its budget is never above the declared
// limit.
//
// Quota headroom is the one non-request input, and it can only downgrade: a
// grade whose budget cannot be reserved within the caller's remaining daily
// tokens would be refused by the ledger with a 429, which would turn an
// automatic convenience into a failure. So the grade is lowered until it fits,
// and when even the lowest one does not, no thinking parameter is sent and the
// reason says `auto:insufficient_quota_headroom`. A downgrade is reported; it is
// never silent.
//
// A caller who sends any reasoning field keeps exactly what they sent: the
// gateway does not touch, replace or second-guess it. The response reports the
// source as `caller`, and every reported choice distinguishes the two.

// The grade set is the one reasoning.mjs already validates, and the only
// capability datum the catalogue carries is `thinking_limit`: there is no
// per-grade declaration to read. So `supported_grades` is *derived* from that
// limit (every grade whose budget fits, `low` always clamped down to it) and
// every report says `supported_grades_basis: 'derived_from_thinking_limit'`
// rather than presenting the list as something the model declared.

export const GRADE_VALUES = Object.freeze(['low', 'medium', 'high']);

// Base budget per grade. These are the gateway's own convention, not a claim
// about a provider's behaviour, and each one is clamped to the model's declared
// thinking_limit before use.
export const GRADE_BUDGETS = Object.freeze({ low: 1024, medium: 4096, high: 8192 });

export const GRADE_THRESHOLDS = Object.freeze({ medium: 2, high: 4 });

export const SUPPORTED_GRADES_BASIS = Object.freeze({
  derived: 'derived_from_thinking_limit',
  none: 'no_thinking_limit_declared',
});

export const REQUEST_REASONING_FIELDS = Object.freeze(['reasoning_effort', 'thinking_budget', 'thinking']);

export function callerChoseReasoning(body) {
  for (const field of REQUEST_REASONING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return true;
  }
  return false;
}

// Whether the caller asked for reasoning, as opposed to only telling the gateway
// not to think. `thinking: { type: 'disabled' }` is still the caller's own
// directive — it keeps the no-change branch above, so their field is forwarded
// untouched — but it asks for less work, not more, so model selection must not
// narrow the pool to thinking-capable models for it. A field that is present but
// unreadable counts as a request: validateReasoning refuses it either way, and
// guessing that it meant "disabled" would be reading a directive into nothing.
export function callerRequiresReasoning(body) {
  if (!body || typeof body !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) return true;
  if (Object.prototype.hasOwnProperty.call(body, 'thinking_budget')) return true;
  if (!Object.prototype.hasOwnProperty.call(body, 'thinking')) return false;
  const thinking = body.thinking;
  const explicitlyDisabled = thinking !== null && typeof thinking === 'object' && thinking.type === 'disabled';
  return !explicitlyDisabled;
}

// What the caller's own reasoning choice was, reported alongside the gateway's
// picks so a reader can tell the two apart. Nothing here re-validates: the
// caller's fields went through validateReasoning before this is called, and this
// only describes them.
export function callerReasoningReport({ body, model }) {
  const effort = GRADE_VALUES.includes(body.reasoning_effort) ? body.reasoning_effort : null;
  let budget = Number.isInteger(body.thinking_budget) && body.thinking_budget > 0 ? body.thinking_budget : null;
  if (budget === null && body.thinking && typeof body.thinking === 'object'
    && Number.isInteger(body.thinking.budget_tokens)) {
    budget = body.thinking.budget_tokens;
  }
  const limitDeclared = declaresThinkingLimit(model);
  const isDecisionModel = Boolean(model?.metadata?.decision_model === true);
  return {
    source: 'caller',
    reason: isDecisionModel ? 'remote_delegated' : 'caller_explicit',
    grade: effort,
    reasoning_effort: effort,
    thinking_budget: budget,
    supported_grades: isDecisionModel ? GRADE_VALUES : supportedGrades(model),
    supported_grades_basis: limitDeclared
      ? SUPPORTED_GRADES_BASIS.derived : (isDecisionModel ? 'remote_decision_delegated' : SUPPORTED_GRADES_BASIS.none),
    thinking_limit: model.thinkingLimit ?? null,
    // The gateway picked nothing here, so it assumed nothing about the grade; but
    // a basis that says the model declares no thinking capability implies the
    // matching assumption, and the two are reported together so they cannot
    // disagree.
    assumptions: (limitDeclared || isDecisionModel) ? [] : ['model_declares_no_thinking_limit'],
    factors: null,
  };
}

function promptPoints(tokens) {
  if (tokens >= 4000) return 2;
  if (tokens >= 800) return 1;
  return 0;
}

function outputPoints(tokens) {
  if (tokens === null) return 0;
  if (tokens >= 2048) return 2;
  if (tokens >= 512) return 1;
  return 0;
}

function toolsPoints(body) {
  return Array.isArray(body.tools) && body.tools.length > 0 ? 1 : 0;
}

// Route contributes one point on any_cloud: that route already accepts the wide
// catalogue (no retention declaration is required of the model), so the request
// is being answered by the least constrained model set and gets the widest
// reasoning allowance this gateway offers automatically. zdr_cloud adds nothing.
function routePoints(route) {
  return route === 'any_cloud' ? 1 : 0;
}

export function gradeForScore(score) {
  if (score >= GRADE_THRESHOLDS.high) return 'high';
  if (score >= GRADE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

// The one reading of "this model declares thinking support", shared by the grade
// list and the basis/assumption pair that describes it.
function declaresThinkingLimit(model) {
  return Number.isInteger(model.thinkingLimit) && model.thinkingLimit > 0;
}

function supportedGrades(model) {
  const limit = model.thinkingLimit;
  if (!declaresThinkingLimit(model)) return [];
  return GRADE_VALUES.filter((grade) => GRADE_BUDGETS[grade] <= limit || grade === 'low');
}

function budgetFor(grade, model) {
  return Math.min(GRADE_BUDGETS[grade], model.thinkingLimit);
}

function noChange(report) {
  return { fields: {}, report };
}

// Which catalogue facts the decision needed and the config does not carry. Empty
// means every input was declared; each entry names a degraded input, never a
// guess that was accepted silently.
function quotaAssumption(availableTokens) {
  return Number.isFinite(availableTokens) ? [] : ['quota_headroom_unknown_treated_as_zero'];
}

// Returns { fields, report }. `fields` is empty when nothing is to be sent; the
// caller merges it into the payload through the existing validation path, so the
// bounds and enums still come from reasoning.mjs rather than being re-checked
// here.
export function selectReasoningGrade({ body, model, route, promptTokens, outputTokens, availableTokens, reserveFor }) {
  if (callerChoseReasoning(body)) {
    return noChange(callerReasoningReport({ body, model }));
  }

  const supported = supportedGrades(model);
  if (supported.length === 0) {
    return noChange({
      source: 'none',
      reason: 'auto:no_reasoning_capability',
      grade: null,
      reasoning_effort: null,
      thinking_budget: null,
      supported_grades: [],
      supported_grades_basis: SUPPORTED_GRADES_BASIS.none,
      detail: `model ${model.id} declares no thinking_limit, so the gateway sends no thinking parameter rather than an unsupported value`,
      // The safe default this degrades to is stated, not implied: nothing is sent.
      assumptions: ['model_declares_no_thinking_limit'],
      factors: null,
    });
  }

  const factors = {
    prompt_tokens: promptTokens,
    prompt_points: promptPoints(promptTokens),
    requested_output_tokens: outputTokens,
    output_points: outputPoints(outputTokens),
    tools_points: toolsPoints(body),
    route_points: routePoints(route),
  };
  const score = factors.prompt_points + factors.output_points + factors.tools_points + factors.route_points;
  const thresholdGrade = gradeForScore(score);
  const thresholdIndex = GRADE_VALUES.indexOf(thresholdGrade);
  const topSupportedIndex = GRADE_VALUES.indexOf(supported[supported.length - 1]);

  let grade = supported[Math.min(thresholdIndex, topSupportedIndex)];
  let reason = `auto:threshold_${grade}`;
  const clampedFrom = grade === thresholdGrade ? null : thresholdGrade;

  // Downgrade until the reservation the ledger would take for this grade fits
  // the caller's remaining daily tokens. `reserveFor` is the ledger's own rule
  // (max of completion and thinking budget), not a second copy of it, so a grade
  // is accepted exactly when it would not be refused with 429.
  const headroom = Number.isFinite(availableTokens) ? availableTokens : 0;
  const fits = (candidate) => reserveFor(budgetFor(candidate, model)) <= headroom;
  let index = GRADE_VALUES.indexOf(grade);
  while (index > 0 && !fits(GRADE_VALUES[index])) {
    index -= 1;
    grade = GRADE_VALUES[index];
    reason = 'auto:clamped_to_quota_headroom';
  }

  if (!fits(grade)) {
    return noChange({
      source: 'none',
      reason: 'auto:insufficient_quota_headroom',
      grade: null,
      reasoning_effort: null,
      thinking_budget: null,
      supported_grades: supported,
      supported_grades_basis: SUPPORTED_GRADES_BASIS.derived,
      detail: `the reservation for the lowest supported thinking budget (${budgetFor('low', model)} tokens) does not fit the ${headroom} tokens left today, so no thinking parameter is sent rather than being refused by the ledger`,
      assumptions: quotaAssumption(availableTokens),
      factors,
    });
  }

  return {
    fields: { reasoning_effort: grade, thinking_budget: budgetFor(grade, model) },
    report: {
      source: 'gateway',
      reason,
      grade,
      reasoning_effort: grade,
      thinking_budget: budgetFor(grade, model),
      supported_grades: supported,
      supported_grades_basis: SUPPORTED_GRADES_BASIS.derived,
      thinking_limit: model.thinkingLimit,
      clamped_from: clampedFrom,
      assumptions: quotaAssumption(availableTokens),
      factors,
    },
  };
}
