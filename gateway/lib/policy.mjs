import { GatewayError } from './errors.mjs';
import { ROUTE_VALUES } from './config.mjs';

// Consent is not attested to this gateway, and nothing here pretends otherwise.
// The app bridge holds the user's consent and refuses to open a socket for a
// cloud route without it; by the time a request reaches the gateway the only
// claim it carries is the route itself. No header is read as proof of consent —
// a header would only let a caller assert something this process cannot verify —
// so every request is unattested and access is decided by route + model policy
// alone. `CONSENT_ATTESTATION` is the value reported with every route refusal.
export const CONSENT_ATTESTATION = 'unattested';

const ROUTE_LABEL_LIMIT = 64;

// An offending route value is echoed back so the caller can see exactly what was
// refused, bounded so an oversized header cannot be reflected in full. A string
// is shown as-is (so whitespace stays visible inside the quoted form) and any
// other JSON type keeps its literal shape instead of collapsing to "".
function describe(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    if (typeof text !== 'string') text = String(value);
  }
  const bounded = text.length <= ROUTE_LABEL_LIMIT ? text : `${text.slice(0, ROUTE_LABEL_LIMIT)}...`;
  return { text: bounded, type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value };
}

// `undefined` is the only spelling of "this source supplied nothing": it is what
// `body.route` yields for a body without the field and what `req.headers` yields
// for an absent header. Everything else — '', '   ', false, [], {}, 0, null —
// was actually sent, and is therefore held to the route vocabulary rather than
// being read as absence. Treating a value the gateway cannot read as "unset" is
// what would let a cloud default decide a route the caller never asked for.
function supplied(value, source) {
  if (value === undefined) return null;
  const route = typeof value === 'string' && ROUTE_VALUES.includes(value.trim()) ? value.trim() : null;
  return { source, route, raw: value };
}

// The route a caller asked for. Accepts `x-route` header or a `route` field in
// the body. Genuine absence — neither source supplied anything — falls back to
// the configured default, which is what every pre-existing client relies on.
// Anything supplied but not one of ROUTE_VALUES is refused by name and source
// before any comparison: it is never replaced by the default, because "the
// gateway guessed your route" is how a cloud request ends up where a local-only
// one was meant. When both sources carry a valid route and disagree, the request
// is refused (`400 route_conflict`) rather than one being chosen.
export function resolveRoute({ headerValue, bodyValue, config }) {
  const header = supplied(headerValue, 'header');
  const body = supplied(bodyValue, 'body');
  for (const source of [header, body]) {
    if (!source || source.route) continue;
    const { text, type } = describe(source.raw);
    throw new GatewayError(400, 'invalid_route',
      `route ${source.source} value ${JSON.stringify(text)} (${type}) is not a recognized route; send exactly one of ${ROUTE_VALUES.join(', ')}. The gateway does not fall back to a default for a value it cannot read`,
      {
        type: 'invalid_request_error',
        param: 'route',
        detail: {
          route: text,
          source: source.source,
          accepted: [...ROUTE_VALUES],
          consent: CONSENT_ATTESTATION,
        },
      });
  }
  if (header && body && header.route !== body.route) {
    throw new GatewayError(400, 'route_conflict',
      `route header ${header.route} and body route ${body.route} disagree; send exactly one`,
      { type: 'invalid_request_error', param: 'route' });
  }
  if (header) return header.route;
  if (body) return body.route;
  return config.route.default;
}

// Route policy is evaluated before any upstream call. local_only is refused
// here and never forwarded: the local plane is a loopback runtime the gateway
// does not proxy. A policy refusal is never downgraded to any_cloud.
// `entry` may be null only for a local_only refusal, which needs no model.
export function enforceRoute({ route, entry, capability }) {
  if (route === 'local_only') {
    throw new GatewayError(400, 'local_only_not_served',
      'local_only is refused by the gateway: the local plane runs directly on the host and does not traverse this gateway; call the local runtime endpoint directly, or resend with route zdr_cloud or any_cloud',
      { type: 'invalid_request_error', param: 'route' });
  }
  if (route === 'zdr_cloud') {
    if (!entry.model.zeroDataRetention || !entry.model.trainingOptOut) {
      throw new GatewayError(403, 'route_policy_violation',
        `model ${entry.model.id} is not zero-data-retention (zero_data_retention=${entry.model.zeroDataRetention}, training_opt_out=${entry.model.trainingOptOut}) and may not be reached on route zdr_cloud; the gateway will not downgrade the route for you`,
        {
          type: 'permission_error',
          param: 'route',
          detail: {
            route,
            model: entry.model.id,
            upstream: entry.upstream.id,
            upstream_class: entry.upstream.class,
            zero_data_retention: entry.model.zeroDataRetention,
            training_opt_out: entry.model.trainingOptOut,
            capability,
          },
        });
    }
  }
  return route;
}

export function resolveModel({ modelId, config, capability }) {
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new GatewayError(400, 'model_required',
      'model is required and must be a string',
      { type: 'invalid_request_error', param: 'model' });
  }
  const id = modelId.trim();
  const entry = config.modelIndex.get(id);
  if (!entry) {
    throw new GatewayError(404, 'model_not_allowed',
      `model ${id} is not in this gateway's allowlist; it will not be forwarded upstream`,
      {
        type: 'invalid_request_error',
        param: 'model',
        detail: { requested: id, capability, permitted: catalogueIds(config, capability) },
      });
  }
  if (!entry.model.capabilities.includes(capability)) {
    throw new GatewayError(400, 'model_capability_unsupported',
      `model ${id} is allowlisted but does not serve ${capability}`,
      {
        type: 'invalid_request_error',
        param: 'model',
        detail: { requested: id, capability, available: [...entry.model.capabilities] },
      });
  }
  return entry;
}

export function catalogueIds(config, capability) {
  const source = capability === 'chat'
    ? config.chatModels
    : capability === 'images' ? config.imageModels : config.videoModels;
  return source.map((entry) => entry.model.id).sort();
}
