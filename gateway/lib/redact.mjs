// Key custody support. Every secret the gateway has ever read is registered
// here and replaced in any string that leaves the process as a log line or an
// HTTP body. Secrets shorter than eight characters are not registered because
// replacing them would shred unrelated text; the gateway refuses to start with
// such a key (see lib/upstream.mjs).

const MIN_SECRET_LENGTH = 8;

export function createRedactor(initialSecrets = []) {
  const secrets = new Set();

  function add(secret) {
    if (typeof secret !== 'string') return;
    const value = secret.trim().replace(/^Bearer\s+/i, '');
    if (value.length < MIN_SECRET_LENGTH) return;
    secrets.add(value);
    // JSON escapes quotes and backslashes; register the escaped form too so a
    // key cannot survive inside a serialised log record.
    secrets.add(JSON.stringify(value).slice(1, -1));
  }

  function text(value) {
    let out = typeof value === 'string' ? value : String(value ?? '');
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
    out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
    out = out.replace(/([?&](?:api[_-]?key|key|token)=)[^&\s"']+/gi, '$1[REDACTED]');
    return out;
  }

  // Used by the streaming relay: an untouched chunk is forwarded as raw bytes,
  // and only a chunk that actually carries a registered secret is decoded and
  // rewritten. Looking at the bytes avoids decoding every token.
  function bufferContains(buffer) {
    if (secrets.size === 0) return false;
    for (const secret of secrets) {
      if (buffer.includes(Buffer.from(secret, 'utf8'))) return true;
    }
    return false;
  }

  function value(input) {
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(input)) out[key] = value(item);
      return out;
    }
    return input;
  }

  for (const secret of initialSecrets) add(secret);
  return { add, text, value, bufferContains, size: () => secrets.size };
}
