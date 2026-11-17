// Consent gate for the standalone gateway.
//
// The app that embeds the gateway supplies its own `authorize` and already knows
// which conversation is asking, so it refuses a cloud route with `403
// consent_required` there. A gateway started by `gateway/server.mjs` has no such
// conversation, and without a gate of its own it would relay cloud traffic with
// no consent check at all. This is that gate: a cloud route is refused unless the
// request carries the consent header, and a local route needs nothing.
import { GatewayError } from './errors.mjs';
import { resolveRoute } from './policy.mjs';

export const CONSENT_HEADER = 'x-consent';

function consentGiven(req) {
  const value = String(req.headers[CONSENT_HEADER] ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * @param {{config: object}} options
 * @returns {(context: {req: object, body: object}) => void} an `authorize` callback
 */
export function requireConsentForCloud({ config }) {
  return function authorize({ req, body }) {
    const route = resolveRoute({ headerValue: req.headers['x-route'], bodyValue: body?.route, config });
    if (route === 'local_only') return;
    if (consentGiven(req)) return;
    throw new GatewayError(403, 'consent_required',
      `route ${route} sends this request off the device; send ${CONSENT_HEADER}: true once the user has agreed`,
      { type: 'permission_error' });
  };
}
