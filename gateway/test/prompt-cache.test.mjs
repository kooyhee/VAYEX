import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheDirectives,
  canonicalizeTools,
  classifyPrefix,
  prefixDigest,
  promptCacheKeyAccepted,
} from '../lib/prompt-cache.mjs';

const tools = [
  { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
];

test('prompt-cache: level 1 is the first system message plus the tools, level 2 the rest', () => {
  const body = {
    messages: [
      { role: 'system', content: 'You are the platform agent.' },
      { role: 'system', content: 'Project: 40_AI보고서' },
      { role: 'user', content: 'fix the bug' },
    ],
    tools,
  };
  const classification = classifyPrefix(body);
  assert.equal(classification.stats.staticMessages, 1);
  assert.equal(classification.stats.semiStaticMessages, 1);
  assert.equal(classification.stats.dynamicMessages, 1);
  assert.deepEqual(classification.violations, []);
});

test('prompt-cache: a system message after the dynamic history is a stated violation', () => {
  const body = {
    messages: [
      { role: 'system', content: 'static' },
      { role: 'user', content: 'go' },
      { role: 'system', content: 'late memory block' },
    ],
  };
  const classification = classifyPrefix(body);
  assert.equal(classification.violations.length, 1);
  assert.equal(classification.violations[0].code, 'system_message_after_dynamic');
});

test('prompt-cache: the tool list becomes byte-repeatable across key orders', () => {
  const reordered = [{ function: { parameters: { type: 'object', properties: { path: { type: 'string' } } }, name: 'read' }, type: 'function' }];
  assert.equal(JSON.stringify(canonicalizeTools(tools)), JSON.stringify(canonicalizeTools(reordered)));
  assert.deepEqual(canonicalizeTools(tools), tools, 'the canonical form still carries the same content');
  assert.equal(canonicalizeTools([]), null);
});

test('prompt-cache: the prefix digest ignores key order but not content', () => {
  const a = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }], tools };
  const b = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }], tools: canonicalizeTools(tools) };
  assert.equal(prefixDigest(a).prefix, prefixDigest(b).prefix);
  const changed = { ...a, messages: [{ role: 'system', content: 'S plus a timestamp 2026-11-08' }, { role: 'user', content: 'u1' }] };
  assert.notEqual(prefixDigest(a).level1, prefixDigest(changed).level1, 'a changed system prompt is a changed level 1');
  assert.notEqual(prefixDigest(a).prefix, prefixDigest(changed).prefix);
});

test('prompt-cache: level 3 growth does not change the cached prefix', () => {
  const base = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }] };
  const grown = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }] };
  assert.equal(prefixDigest(base).prefix, prefixDigest(grown).prefix);
});

test('prompt-cache: anthropic breakpoints land on array content and are reported otherwise', () => {
  const entry = { model: { id: 'anthropic/claude-3.5-haiku' }, upstream: { baseUrl: 'https://api.anthropic.com' } };
  const arrayBody = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system instruction' }] },
      { role: 'system', content: [{ type: 'text', text: 'project memory' }] },
      { role: 'user', content: 'go' },
    ],
  };
  const applied = cacheDirectives({ body: arrayBody, entry });
  assert.equal(applied.family, 'anthropic');
  assert.equal(applied.applied, true);
  assert.equal(applied.fields.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(applied.fields.messages[1].content[0].cache_control.type, 'ephemeral');
  assert.equal(applied.fields.messages[2].content, 'go', 'the dynamic turn is never reshaped');
  assert.notEqual(applied.fields.messages, arrayBody.messages, 'the caller body is copied, not mutated');

  const stringBody = { messages: [{ role: 'system', content: 'plain string system' }, { role: 'user', content: 'go' }] };
  const notes = cacheDirectives({ body: stringBody, entry });
  assert.equal(notes.applied, false);
  assert.equal(notes.notes.includes('messages[0].content_not_array'), true);
});

test('prompt-cache: openai gets a session key only when the model declares support', () => {
  const declaring = { model: { id: 'gpt-4o-mini', supportsPromptCacheKey: true }, upstream: { baseUrl: 'https://api.openai.com' } };
  const silent = { model: { id: 'gpt-4o-mini', supportsPromptCacheKey: false }, upstream: { baseUrl: 'https://api.openai.com' } };
  const body = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'go' }] };
  const applied = cacheDirectives({ body, entry: declaring, sessionKey: 'a|b|c' });
  assert.equal(applied.applied, true);
  assert.equal(applied.fields.prompt_cache_key, 'a|b|c');
  const refused = cacheDirectives({ body, entry: silent, sessionKey: 'a|b|c' });
  assert.equal(refused.applied, false);
  assert.equal(refused.fields.prompt_cache_key, undefined);
  assert.equal(refused.notes.includes('model_does_not_declare_prompt_cache_key'), true);
});

test('prompt-cache: provider cache can be switched off by the profile', () => {
  const entry = { model: { id: 'claude-3-5-haiku' }, upstream: { baseUrl: 'https://api.anthropic.com' } };
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'S' }] }, { role: 'user', content: 'go' }] };
  const off = cacheDirectives({ body, entry, providerCache: false });
  assert.equal(off.applied, false);
  assert.equal(off.notes.includes('provider_cache_disabled_by_profile'), true);
});

test('prompt-cache: a caller key is accepted only on a model that declares one', () => {
  const supported = promptCacheKeyAccepted({ body: { prompt_cache_key: 'k' }, entry: { model: { id: 'm', supportsPromptCacheKey: true } } });
  assert.equal(supported.accepted, true);
  const unsupported = promptCacheKeyAccepted({ body: { prompt_cache_key: 'k' }, entry: { model: { id: 'm' } } });
  assert.equal(unsupported.accepted, false);
  assert.match(unsupported.reason, /supports_prompt_cache_key/);
  const absent = promptCacheKeyAccepted({ body: {}, entry: { model: { id: 'm' } } });
  assert.equal(absent.accepted, true, 'no key sent is not a refusal');
});
