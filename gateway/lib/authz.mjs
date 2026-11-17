import { GatewayError } from './errors.mjs';

// Turns the inbound Authorization header into the value forwarded to a
// pass-through upstream. Nothing here is logged: this string is a credential.
export function clientAuthorization(headers) {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (!/^Bearer\s+\S+$/.test(value) && !/^Bearer$/i.test(value)) {
    // Anything that is not a Bearer credential is not forwarded as one.
    return null;
  }
  return /^Bearer\s+\S+$/.test(value) ? value : null;
}

// Checked before a quota reservation is taken, so a request that cannot be
// authenticated never consumes the caller's daily budget.
export function preflightAuth({ upstream, key, headers }) {
  if (upstream.authMode === 'gateway_key') {
    if (!key || !key.value) {
      throw new GatewayError(503, 'gateway_key_missing',
        `upstream ${upstream.id} requires the gateway's provider key, and ${key ? key.envName : 'the configured environment variable'} is empty; this gateway cannot serve that model until an operator sets it`,
        { type: 'configuration_error', detail: { upstream: upstream.id, env: key ? key.envName : null } });
    }
    if (!key.usable) {
      throw new GatewayError(503, 'gateway_key_too_short',
        `the provider key in ${key.envName} is shorter than 8 characters and is refused; set a real provider key`,
        { type: 'configuration_error', detail: { upstream: upstream.id, env: key.envName } });
    }
    return null;
  }
  if (upstream.authMode === 'pass_through') {
    const forwarded = clientAuthorization(headers);
    if (!forwarded) {
      throw new GatewayError(401, 'client_key_required',
        `upstream ${upstream.id} uses pass-through authentication: send your own provider key as "Authorization: Bearer <key>"; the gateway stores no key for this upstream`,
        { type: 'authentication_error' });
    }
    return forwarded;
  }
  return null;
}

// The credential to send to one upstream, or null when that upstream takes no
// credential. Reads only that upstream's own environment variable.
export function keyForUpstream(upstream, keys) {
  if (upstream.authMode !== 'gateway_key') return null;
  return keys.get(upstream.id) || null;
}
