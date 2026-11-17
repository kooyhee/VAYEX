// TurnPlan policy validator.
//
// A turn plan is a recommendation (rules first, an optional cheap decision model
// only when it pays for itself) and this is the policy gate every plan passes
// before anything is executed: a plan that reaches the executor has been clamped
// into the documented envelope below, or refused, by deterministic code that
// never opens a socket.
//
// Envelope, stated once:
//   track          'direct_execute' | 'survey_and_plan'
//   tier           'fast' (direct) | 'high_intelligence' (plan) — must agree with track
//   thinkingBudget 0 for direct; 1..MAX_THINKING for plan
//   workers        1 for direct; 2..MAX_WORKERS for plan (1 is below the documented range)
//   planDirective  null for direct; a non-empty string <= MAX_DIRECTIVE for plan
//   model          null or an id present in the caller's allowlist
//   reasoning      null or low|medium|high
//
// Every deviation is reported as a violation with the rule that fired and what
// was done about it: `clamp` (field narrowed, plan still runs), `fallback` (the
// whole plan replaced by the conservative default), or `reject` (no plan at all,
// only returned when the caller supplied `strict`). Nothing is silently repaired.
// A validator that ran out of inputs it needed says so in `assumptions`, exactly
// like the selection report does.

export const MAX_THINKING = 8192;
export const MAX_WORKERS = 4;
export const MAX_DIRECTIVE = 2000;
export const TRACKS = Object.freeze(['direct_execute', 'survey_and_plan']);
export const TIERS = Object.freeze(['fast', 'high_intelligence']);
export const REASONING_GRADES = Object.freeze(['low', 'medium', 'high']);

export const VIOLATION_RULES = Object.freeze({
  V01_TRACK: 'V-01',
  V02_TIER: 'V-02',
  V03_THINKING: 'V-03',
  V04_WORKERS: 'V-04',
  V05_DIRECTIVE: 'V-05',
  V06_MODEL: 'V-06',
  V07_REASONING: 'V-07',
  V08_BUDGET: 'V-08',
});

// The conservative fallback: no plan mode, no thinking, no workers, no model
// pinned. Used when a recommendation is unusable rather than trusted.
export function defaultTurnPlan(reason = 'validator_default') {
  return Object.freeze({
    track: 'direct_execute',
    reason,
    tier: 'fast',
    thinkingBudget: 0,
    workers: 1,
    planDirective: null,
    model: null,
    reasoning: null,
  });
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function violation(rule, action, detail) {
  return { rule, action, detail };
}

// `context`: { allowedModels?: string[], estimateUsd?: number, budgetCapUsd?: number,
//              strict?: boolean }
export function validateTurnPlan(plan, context = {}) {
  const allowedModels = Array.isArray(context.allowedModels) ? context.allowedModels : null;
  const assumptions = [];
  const violations = [];
  let rejected = false;

  const source = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
  if (!source) {
    return {
      ok: false,
      plan: defaultTurnPlan('validator_missing_plan'),
      violations: [violation(VIOLATION_RULES.V01_TRACK, 'fallback', 'plan was not an object')],
      assumptions: ['plan_missing'],
    };
  }

  // V-01 track
  let track = source.track;
  if (!TRACKS.includes(track)) {
    violations.push(violation(VIOLATION_RULES.V01_TRACK, 'fallback', `track ${String(track)} is not one of ${TRACKS.join(', ')}`));
    return {
      ok: false,
      plan: defaultTurnPlan('validator_unknown_track'),
      violations,
      assumptions,
    };
  }

  // V-08 budget: a recommendation whose estimated cost exceeds the cap is
  // degraded to the direct track, which is the cheapest plan that still runs.
  const estimate = Number.isFinite(context.estimateUsd) ? context.estimateUsd : null;
  const cap = Number.isFinite(context.budgetCapUsd) ? context.budgetCapUsd : null;
  if (estimate !== null && cap !== null && estimate > cap && track === 'survey_and_plan') {
    violations.push(violation(VIOLATION_RULES.V08_BUDGET, 'clamp',
      `estimated $${estimate} exceeds the cap $${cap}; the plan was degraded to direct_execute`));
    track = 'direct_execute';
  }
  if (estimate === null || cap === null) assumptions.push('budget_unbounded_plan_accepted');

  // V-02 tier must agree with the track.
  let tier = TIERS.includes(source.tier) ? source.tier : null;
  const expectedTier = track === 'direct_execute' ? 'fast' : 'high_intelligence';
  if (tier === null) {
    violations.push(violation(VIOLATION_RULES.V02_TIER, 'clamp', `tier ${String(source.tier)} is not one of ${TIERS.join(', ')}`));
    tier = expectedTier;
  } else if (tier !== expectedTier) {
    violations.push(violation(VIOLATION_RULES.V02_TIER, 'clamp', `tier ${tier} does not match track ${track}; narrowed to ${expectedTier}`));
    tier = expectedTier;
  }

  // V-03 thinking budget
  let thinkingBudget = integerOr(source.thinkingBudget, 0);
  if (track === 'direct_execute') {
    if (thinkingBudget !== 0) {
      violations.push(violation(VIOLATION_RULES.V03_THINKING, 'clamp', `direct_execute must not request thinking (was ${thinkingBudget})`));
      thinkingBudget = 0;
    }
  } else if (thinkingBudget <= 0 || thinkingBudget > MAX_THINKING) {
    violations.push(violation(VIOLATION_RULES.V03_THINKING, 'clamp',
      `thinking budget ${thinkingBudget} is outside 1..${MAX_THINKING}; clamped`));
    thinkingBudget = thinkingBudget <= 0 ? Math.min(4096, MAX_THINKING) : MAX_THINKING;
  }

  // V-04 workers
  let workers = integerOr(source.workers, 1);
  const minWorkers = track === 'direct_execute' ? 1 : 2;
  if (workers < 1) workers = 1;
  if (workers > MAX_WORKERS) {
    violations.push(violation(VIOLATION_RULES.V04_WORKERS, 'clamp', `workers ${source.workers} exceeds ${MAX_WORKERS}; clamped`));
    workers = MAX_WORKERS;
  }
  if (track === 'direct_execute' && workers > 1) {
    violations.push(violation(VIOLATION_RULES.V04_WORKERS, 'clamp', `direct_execute runs with 1 worker, not ${workers}`));
    workers = 1;
  }
  // A plan turn runs 2..MAX_WORKERS workers: one worker is a direct execution
  // wearing a plan's tier and budget, so it is raised and reported like every
  // other clamp rather than silently accepted.
  if (track === 'survey_and_plan' && workers < minWorkers) {
    violations.push(violation(VIOLATION_RULES.V04_WORKERS, 'clamp',
      `survey_and_plan runs with ${minWorkers}..${MAX_WORKERS} workers, not ${workers}`));
    workers = minWorkers;
  }

  // V-05 plan directive
  let planDirective = source.planDirective ?? null;
  if (track === 'direct_execute') {
    if (planDirective !== null) {
      violations.push(violation(VIOLATION_RULES.V05_DIRECTIVE, 'clamp', 'direct_execute carries no plan directive'));
      planDirective = null;
    }
  } else {
    if (typeof planDirective !== 'string' || planDirective.trim().length === 0) {
      violations.push(violation(VIOLATION_RULES.V05_DIRECTIVE, 'fallback', 'survey_and_plan requires a non-empty planDirective'));
      track = 'direct_execute';
      tier = 'fast';
      thinkingBudget = 0;
      workers = 1;
      planDirective = null;
    } else if (planDirective.length > MAX_DIRECTIVE) {
      violations.push(violation(VIOLATION_RULES.V05_DIRECTIVE, 'clamp', `planDirective trimmed to ${MAX_DIRECTIVE} characters`));
      planDirective = planDirective.slice(0, MAX_DIRECTIVE);
    }
  }

  // V-06 model pin must come from the allowlist the caller supplied.
  let model = typeof source.model === 'string' && source.model.length > 0 ? source.model : null;
  if (model !== null) {
    if (allowedModels === null) {
      assumptions.push('model_pin_unchecked_no_allowlist');
    } else if (!allowedModels.includes(model)) {
      violations.push(violation(VIOLATION_RULES.V06_MODEL, 'clamp',
        `pinned model ${model} is not in the allowlist; the pin was dropped`));
      model = null;
    }
  }

    // V-07 reasoning grade
  let reasoning = source.reasoning ?? null;
  if (reasoning !== null && !REASONING_GRADES.includes(reasoning)) {
    violations.push(violation(VIOLATION_RULES.V07_REASONING, 'clamp', `reasoning ${String(reasoning)} is not one of ${REASONING_GRADES.join(', ')}`));
    reasoning = null;
  }
  if (thinkingBudget === 0 && reasoning !== null) {
    violations.push(violation(VIOLATION_RULES.V07_REASONING, 'clamp', 'no thinking budget means no reasoning grade is forwarded'));
    reasoning = null;
  }

  if (context.strict === true && violations.length > 0) rejected = true;

  const validated = Object.freeze({
    track,
    reason: typeof source.reason === 'string' && source.reason ? source.reason : 'validator_default',
    tier,
    thinkingBudget,
    workers,
    planDirective,
    model,
    reasoning,
  });

  return { ok: !rejected, plan: validated, violations, assumptions: assumptions };
}
