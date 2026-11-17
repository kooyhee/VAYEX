// A refusal or upstream failure that the gateway turns into an HTTP response.
// The message is always written for a human operator and never contains a key:
// callers pass provider text through the redactor before it lands here.

export class GatewayError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.type = options.type || 'gateway_error';
    this.param = options.param === undefined ? null : options.param;
    this.headers = options.headers || null;
    this.detail = options.detail === undefined ? null : options.detail;
  }

  toBody() {
    const error = {
      message: this.message,
      type: this.type,
      code: this.code,
      param: this.param,
    };
    if (this.detail !== null) error.detail = this.detail;
    return { error };
  }
}

export function isGatewayError(value) {
  return value instanceof GatewayError;
}
