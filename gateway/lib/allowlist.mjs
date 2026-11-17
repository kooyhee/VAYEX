// Field allowlists. A client body is rebuilt from these keys only; anything
// else the client sends is dropped before it reaches an upstream. `route` is a
// gateway extension and is deliberately absent: it never leaves this process.
//
// Reasoning controls (`reasoning_effort`, `thinking`, `thinking_budget`) are
// deliberately absent too: they are validated and bounded per model in
// reasoning.mjs and merged into the payload only after validation, so an
// unbounded or unknown-dialect thinking budget can never reach an upstream.

export const CHAT_FIELDS = Object.freeze([
  'model',
  'messages',
  'temperature',
  'top_p',
  'n',
  'stream',
  'stream_options',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'seed',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'user',
  'service_tier',
  'modalities',
  'audio',
  'prediction',
  'prompt_cache_key',
  'provider',
]);

export const IMAGE_FIELDS = Object.freeze([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'style',
  'response_format',
  'user',
  'seed',
  'background',
  'output_format',
]);

export const VIDEO_FIELDS = Object.freeze([
  'model',
  'prompt',
  'duration',
  'duration_s',
  'size',
  'resolution',
  'aspect_ratio',
  'seed',
  'negative_prompt',
  'image',
]);

export function pickFields(source, allowed) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}
