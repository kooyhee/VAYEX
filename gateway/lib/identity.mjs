import { GatewayError } from './errors.mjs';

// The identity is a bounded opaque token, not a name: the ledger keys on it and
// it appears in quota detail, so it must not be able to carry a payload into a
// log line or a filesystem-adjacent structure.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveIdentity(headerName, headers, { required = true } = {}) {
  const raw = headers[headerName];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (!required) return null;
    throw new GatewayError(401, 'identity_required',
      `missing identity: send the ${headerName} header (opaque token, 1-128 characters of A-Z a-z 0-9 . _ : -)`,
      { type: 'authentication_error' });
  }
  if (!TOKEN.test(value)) {
    throw new GatewayError(400, 'identity_invalid',
      `${headerName} must be an opaque token of 1-128 characters from A-Z a-z 0-9 . _ : -`,
      { type: 'invalid_request_error', param: headerName });
  }
  return value;
}
