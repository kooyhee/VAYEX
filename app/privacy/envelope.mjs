// The envelope walker.
//
// SEC-01: the old pass masked `messages[].content` strings and nothing else, so
// tool-call arguments, multimodal array blocks, `role: "tool"` payloads and
// image/video `prompt` fields went to the provider verbatim. This walker covers
// every slot a request can carry text in, and it is the same walker on the way
// back in, so what was pseudonymized is what gets restored.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Message roles whose content is tool output rather than prose. */
const TOOL_ROLES = new Set(['tool', 'function', 'observation']);

// Protocol control fields that never contain user data or natural text.
const PROTOCOL_ALLOWLIST = new Set([
  'model', 'temperature', 'top_p', 'stream', 'max_tokens', 'max_completion_tokens',
  'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format',
  'stream_options', 'thinking', 'tools', 'tool_choice', 'parallel_tool_calls',
  'route', 'role', 'agent_role', 'plan_mode', 'plan_tier'
]);

/**
 * Rewrite every maskable string in a request body.
 * Covers messages content, tool_calls arguments, role:tool payloads, prompt,
 * body.user, and tools[].function.(description|parameters).
 *
 * `meta.path` is the *published* field path — identifiers only, a non-identifier
 * JSON key replaced by a placeholder — while `meta.detectionHint` carries the raw
 * key text for the detector alone. A key is context ("계좌번호": a value under it is
 * an account number) and it is also user data, so the two roles are separate:
 * detection may read the key, nothing published may carry it.
 * @param {object} body
 * @param {(text:string, meta:{path:string,kind:string,detectionHint?:string}) => string} mapText
 */
export function mapEnvelope(body, mapText) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((message, index) => mapMessage(message, index, mapText));
  }
  if (typeof body.prompt === 'string') {
    // Image and video routes carry a bare `prompt`, not `messages`.
    out.prompt = mapText(body.prompt, { path: 'prompt', kind: 'prompt' });
  }
  if (typeof body.negative_prompt === 'string') {
    out.negative_prompt = mapText(body.negative_prompt, { path: 'negative_prompt', kind: 'prompt' });
  }
  if (typeof body.user === 'string') {
    out.user = mapText(body.user, { path: 'user', kind: 'user' });
  }
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool, toolIndex) => mapToolDefinition(tool, `tools[${toolIndex}]`, mapText));
  }
  return out;
}

function mapToolDefinition(tool, basePath, mapText) {
  if (!isPlainObject(tool)) return tool;
  const fn = tool.function;
  if (!isPlainObject(fn)) return { ...tool };
  const copyFn = { ...fn };
  if (typeof copyFn.description === 'string') {
    copyFn.description = mapText(copyFn.description, { path: `${basePath}.function.description`, kind: 'text' });
  }
  if (isPlainObject(copyFn.parameters)) {
    copyFn.parameters = mapJsonStrings(copyFn.parameters, `${basePath}.function.parameters`, `${basePath}.function.parameters`, mapText);
  }
  return { ...tool, function: copyFn };
}

function mapMessage(message, index, mapText) {
  if (!isPlainObject(message)) return message;
  const basePath = `messages[${index}]`;
  const kind = TOOL_ROLES.has(String(message.role ?? '')) ? 'tool' : 'text';
  const copy = { ...message };
  if (typeof message.content === 'string' || Array.isArray(message.content)) {
    copy.content = mapContent(message.content, `${basePath}.content`, kind, mapText);
  }
  if (Array.isArray(message.tool_calls)) {
    copy.tool_calls = message.tool_calls.map((call, callIndex) => mapToolCall(call, `${basePath}.tool_calls[${callIndex}]`, mapText));
  }
  if (typeof message.name === 'string' && TOOL_ROLES.has(String(message.role ?? ''))) {
    // A tool name is an identifier the model calls back into; it is never PII.
    copy.name = message.name;
  }
  return copy;
}

function mapToolCall(call, basePath, mapText) {
  if (!isPlainObject(call)) return call;
  const fn = call.function;
  if (!isPlainObject(fn) || typeof fn.arguments !== 'string') return { ...call };
  return {
    ...call,
    function: {
      ...fn,
      arguments: mapArguments(fn.arguments, `${basePath}.function.arguments`, mapText),
    },
  };
}

function mapContent(content, path, kind, mapText) {
  if (typeof content === 'string') return mapText(content, { path, kind });
  if (!Array.isArray(content)) return content;
  return content.map((part, index) => {
    if (!isPlainObject(part)) return part;
    if (typeof part.text === 'string') {
      return { ...part, text: mapText(part.text, { path: `${path}[${index}].text`, kind }) };
    }
    // Image/audio parts carry bytes or URLs; the gate screens those, the walker
    // must not rewrite them into something the provider cannot decode.
    return part;
  });
}

/**
 * Tool-call arguments are a serialized JSON object. Masking its *values* keeps
 * the JSON parseable (`{"path": "/home/[PERSON_1]/x"}`), which masking the raw
 * string could not guarantee. If the string is not JSON, it is masked as text.
 */
export function mapArguments(raw, path, mapText) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return mapText(raw, { path, kind: 'code', detectionHint: path });
  }
  return JSON.stringify(mapJsonStrings(parsed, path, path, mapText));
}

// A field path is published: it is on the relayed privacy line and on the gateway
// event record, the two places that must hold ids and counts only. A JSON *key* is
// user data just like a value — a contact number is a legal tool-argument key — so
// appending it raw put the original value back on the wire in the one place the
// gate promises it never appears. The key itself stays in the body (the provider
// needs it); only the reported segment is normalised, and it stays stable so two
// findings in the same field still collapse to one path.
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// A long digit run inside an otherwise identifier-shaped key is still data
// (`key01012345678`), so that case gets the placeholder too.
const KEY_DIGIT_RUN = /\d{4,}/;
const KEY_PLACEHOLDER = '*';

/** The path segment for one JSON key: the key itself when it is an identifier. */
export function fieldPathSegment(key) {
  const text = String(key);
  return SAFE_KEY.test(text) && !KEY_DIGIT_RUN.test(text) ? text : KEY_PLACEHOLDER;
}

function mapJsonStrings(value, path, hintPath, mapText) {
  if (typeof value === 'string') return mapText(value, { path, kind: 'string-literal', detectionHint: hintPath });
  if (Array.isArray(value)) return value.map((item, index) => mapJsonStrings(item, `${path}[${index}]`, `${hintPath}[${index}]`, mapText));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      // The two paths diverge here and only here: `path` is published, `hintPath`
      // is the raw key the detector reads as context.
      out[key] = mapJsonStrings(child, `${path}.${fieldPathSegment(key)}`, `${hintPath}.${key}`, mapText);
    }
    return out;
  }
  return value;
}

/** Every maskable string in a body, with its field path — what the gate scans. */
export function collectStrings(body) {
  const slots = [];
  mapEnvelope(body, (text, meta) => {
    slots.push({ ...meta, value: text });
    return text;
  });
  return slots;
}

/**
 * Restore pseudonyms anywhere in a value. Restoration runs on raw strings rather
 * than through `mapArguments`, because a restoring parse could reject JSON a
 * provider formatted differently — a plain replacement never can.
 */
export function restoreDeep(value, restoreFn) {
  if (typeof value === 'string') return restoreFn(value);
  if (Array.isArray(value)) return value.map((item) => restoreDeep(item, restoreFn));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = restoreDeep(child, restoreFn);
    return out;
  }
  return value;
}

export function restoreEnvelope(body, restoreFn) {
  return restoreDeep(body, restoreFn);
}
