// Prompt-prefix hierarchy and provider cache directives.
//
// Providers cache a *prefix*, not a conversation: the bytes at the start of the
// request must be identical between turns or every turn is a cache miss. The
// gateway therefore treats the request as three levels and never reorders them:
//
//   Level 1 STATIC      the system instruction (messages[0] with role system, or
//                       the top-level `system` string) plus the tool schemas. It
//                       is what must be byte-identical for the whole session.
//   Level 2 SEMI-STATIC project and memory context: any further leading system
//                       messages, before the first non-system message. It may
//                       change when memory is refreshed, but not per turn.
//   Level 3 DYNAMIC     history and the current user turn. It grows, and nothing
//                       at level 3 may be written before level 1/2 is stable.
//
// What this module does:
//   * `classifyPrefix` reports which level every leading system message belongs
//     to, so `x-gateway-prefix-*` headers can name the layout a caller produced.
//   * `canonicalizeTools` makes the tool list byte-repeatable (deep key sort) —
//     clients that rebuild the array each turn with a different key order
//     otherwise invalidate their own cache.
//   * `prefixDigest` hashes level 1 and level 2 so a change is detectable; a
//     changed digest is reported, never repaired (rewriting a caller's prompt
//     would change the answer).
//   * `cacheDirectives` decides the provider-specific cache controls:
//       anthropic  `cache_control: {type:'ephemeral'}` on content blocks at the
//                  end of level 1 and level 2 (max 4 breakpoints; only when the
//                  content is already an array — the gateway never reshapes a
//                  caller's content, and a string system prompt is reported as
//                  `content_not_array` instead of silently converted).
//       openai     `prompt_cache_key`: accepted from the caller only when the
//                  model declares `supports_prompt_cache_key`, otherwise the
//                  gateway supplies a stable session+segment key when the model
//                  declares support. A model that declares none gets no key and
//                  no 400 — the previous "HTTP 400 on prompt_cache_key" was this
//                  gateway's own `unsupported_parameter` guard rejecting a field
//                  the allowlist already carried, not a provider rejection.
//
// Everything here is byte-oriented and deterministic: no clock, no randomness,
// no reordering of messages.

import { createHash } from 'node:crypto';

export const PREFIX_LEVELS = Object.freeze({ STATIC: 1, SEMI_STATIC: 2, DYNAMIC: 3 });
export const MAX_CACHE_BREAKPOINTS = 4;
export const CACHE_CONTROL_EPHEMERAL = Object.freeze({ type: 'ephemeral' });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSystemMessage(message) {
  return isObject(message) && message.role === 'system';
}

// Splits the leading system messages into level 1 (the first one) and level 2
// (the rest), which is how a project/memory block is conventionally appended.
export function classifyPrefix(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasTopLevelSystem = typeof body?.system === 'string' && body.system.length > 0;
  const stats = { staticMessages: 0, semiStaticMessages: 0, dynamicMessages: 0, tools: Array.isArray(body?.tools) ? body.tools.length : 0 };

  if (hasTopLevelSystem) stats.staticMessages += 1;

  let index = 0;
  if (messages.length > 0 && isSystemMessage(messages[0]) && !hasTopLevelSystem) {
    stats.staticMessages += 1;
    index = 1;
  }
  while (index < messages.length && isSystemMessage(messages[index])) {
    stats.semiStaticMessages += 1;
    index += 1;
  }
  stats.dynamicMessages = messages.length - index;

  const levelOf = (messageIndex) => {
    if (messageIndex < stats.staticMessages) return PREFIX_LEVELS.STATIC;
    if (messageIndex < stats.staticMessages + stats.semiStaticMessages) return PREFIX_LEVELS.SEMI_STATIC;
    return PREFIX_LEVELS.DYNAMIC;
  };

  const violations = [];
  // A system message after the first non-system message cannot be part of the
  // cached prefix; saying so is the only honest report.
  messages.forEach((message, messageIndex) => {
    if (isSystemMessage(message) && messageIndex >= stats.staticMessages + stats.semiStaticMessages) {
      violations.push({ code: 'system_message_after_dynamic', index: messageIndex });
    }
  });

  return { stats, levelOf, violations, hasTopLevelSystem };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Byte-repeatable tool list: same schema, same bytes, every turn.
export function canonicalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((tool) => JSON.parse(stableStringify(tool)));
}

function bytesOfLevel(body, level) {
  const classification = classifyPrefix(body);
  const parts = [];
  if (level === PREFIX_LEVELS.STATIC) {
    if (classification.hasTopLevelSystem) parts.push(`system:${body.system}`);
    if (Array.isArray(body.messages) && body.messages.length > 0 && !classification.hasTopLevelSystem) {
      parts.push(`m0:${stableStringify(body.messages[0])}`);
    }
    parts.push(`tools:${Array.isArray(body.tools) && body.tools.length > 0 ? stableStringify(body.tools) : 'none'}`);
  } else if (level === PREFIX_LEVELS.SEMI_STATIC) {
    const start = classification.hasTopLevelSystem ? 0 : (body.messages?.length > 0 && isSystemMessage(body.messages[0]) ? 1 : 0);
    const end = start + classification.stats.semiStaticMessages;
    for (let index = start; index < end; index += 1) parts.push(`m${index}:${stableStringify(body.messages[index])}`);
  } else {
    const start = classification.stats.staticMessages + classification.stats.semiStaticMessages;
    for (let index = start; index < (body.messages?.length ?? 0); index += 1) parts.push(`m${index}:${stableStringify(body.messages[index])}`);
  }
  return parts.join('\n');
}

export function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function prefixDigest(body) {
  const level1 = bytesOfLevel(body, PREFIX_LEVELS.STATIC);
  const level2 = bytesOfLevel(body, PREFIX_LEVELS.SEMI_STATIC);
  const level3 = bytesOfLevel(body, PREFIX_LEVELS.DYNAMIC);
  const classification = classifyPrefix(body);
  return {
    prefix: digestOf(`${level1}\n${level2}`),
    level1: digestOf(level1),
    level2: digestOf(level2),
    level3: digestOf(level3),
    levels: classification.stats,
    violations: classification.violations,
    stable: classification.violations.length === 0,
  };
}

// A digest that changed between two turns of the same session means the cache
// tree was broken; the caller reports it (header + cache.report event) rather
// than trying to rewrite the caller's prompt back into shape.
export function prefixDrift(previous, current) {
  if (!previous || !current) return null;
  return {
    prefix_changed: previous.prefix !== current.prefix,
    level1_changed: previous.level1 !== current.level1,
    level2_changed: previous.level2 !== current.level2,
  };
}

function familyFrom({ upstream, model } = {}) {
  const id = String(model?.id ?? '').toLowerCase();
  const host = String(upstream?.baseUrl ?? '').toLowerCase();
  if (id.includes('claude') || id.includes('anthropic') || host.includes('anthropic')) return 'anthropic';
  if (id.includes('gpt') || id.includes('openai') || host.includes('openai.com')) return 'openai';
  return 'other';
}

function lastContentBlockIndex(message) {
  if (!isObject(message) || !Array.isArray(message.content)) return -1;
  return message.content.length - 1;
}

// Returns { fields, applied, family, notes, breakpoints }. `fields` is merged
// into the upstream payload by the chat handler only after validation, so an
// upstream that never declared support never receives a cache field.
export function cacheDirectives({ body, entry, sessionKey = null, providerCache = true } = {}) {
  const family = familyFrom(entry);
  const notes = [];
  const fields = {};
  const breakpoints = [];

  if (!providerCache) {
    notes.push('provider_cache_disabled_by_profile');
    return { fields, applied: false, family, notes, breakpoints };
  }

  if (family === 'anthropic') {
    const classification = classifyPrefix(body);
    const candidates = [];
    if (Array.isArray(body?.messages) && body.messages.length > 0) {
      candidates.push(0);
      if (classification.stats.semiStaticMessages > 0) {
        candidates.push(classification.stats.staticMessages + classification.stats.semiStaticMessages - 1);
      }
    }
    if (candidates.length === 0) {
      notes.push('no_message_prefix_to_mark');
    }
    for (const index of candidates.slice(0, MAX_CACHE_BREAKPOINTS - 2)) {
      const blockIndex = lastContentBlockIndex(body.messages[index]);
      if (blockIndex < 0) {
        notes.push(`messages[${index}].content_not_array`);
        continue;
      }
      const block = body.messages[index].content[blockIndex];
      if (!isObject(block) || block.type !== 'text') {
        notes.push(`messages[${index}].last_block_not_text`);
        continue;
      }
      if (isObject(block.cache_control)) continue;
      breakpoints.push({ message: index, block: blockIndex });
    }
    if (breakpoints.length === 0) {
      return { fields, applied: false, family, notes, breakpoints };
    }
    // A copy, never a mutation of the caller's body: the same request object is
    // reused by the PII masker and by the selection record.
    fields.messages = body.messages.map((message, index) => {
      const hit = breakpoints.find((breakpoint) => breakpoint.message === index);
      if (!hit || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block, blockIndex) => (blockIndex === hit.block
          ? { ...block, cache_control: { ...CACHE_CONTROL_EPHEMERAL } }
          : block)),
      };
    });
    return { fields, applied: true, family, notes, breakpoints };
  }

  if (family === 'openai') {
    const supported = entry?.model?.supportsPromptCacheKey === true;
    if (!supported) {
      notes.push('model_does_not_declare_prompt_cache_key');
      return { fields, applied: false, family, notes, breakpoints };
    }
    if (sessionKey) {
      fields.prompt_cache_key = sessionKey;
      breakpoints.push({ prompt_cache_key: true });
      return { fields, applied: true, family, notes, breakpoints };
    }
    notes.push('no_session_key_for_prompt_cache_key');
    return { fields, applied: false, family, notes, breakpoints };
  }

  notes.push('provider_has_no_cache_controls');
  return { fields, applied: false, family, notes, breakpoints };
}

// The one decision point for a caller-supplied prompt_cache_key: accepted only
// on a model that declares support. Anything else is refused by name rather than
// forwarded to an upstream that would 400 on it.
export function promptCacheKeyAccepted({ body, entry }) {
  if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'prompt_cache_key') || body.prompt_cache_key === null) {
    return { accepted: true, reason: 'caller_sent_no_prompt_cache_key' };
  }
  if (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key.length === 0) {
    return { accepted: false, reason: 'prompt_cache_key must be a non-empty string' };
  }
  if (entry?.model?.supportsPromptCacheKey !== true) {
    return {
      accepted: false,
      reason: `model ${entry?.model?.id ?? '?'} does not declare supports_prompt_cache_key; the gateway will not forward a cache key an upstream has not been declared to accept`,
    };
  }
  return { accepted: true, reason: 'model_declares_prompt_cache_key' };
}
