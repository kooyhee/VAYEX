// Deterministic PII masking and restoration — now a thin adapter over the
// unified Privacy Guard (`app/privacy/**`).
//
// What changed here and why (SEC-01 / SEC-04):
//   * `maskMessages` walks the whole envelope: string content, multimodal array
//     blocks, `tool_calls[].function.arguments` and `role: "tool"` payloads.
//     Arguments used to be "preserved verbatim", which shipped a card number and
//     an email inside a function call straight to the provider.
//   * `127.0.0.1` and RFC 5737 hosts are shielded before detection, so the app's
//     own loopback addresses are no longer rewritten into `[IP_1]`.
//   * A 13-digit `Date.now()` no longer reads as a bank account: accounts need
//     hyphen grouping plus bank context.
//   * Post-October-2020 RRNs (random tail, no check digit) are detected from
//     structure gated on surrounding context, alongside the pre-2020 mod-11 rule.
//
// The vault is session-scoped, so the same value keeps its index across turns.
// Logging records rule ids and counts only, never a matched value.

export {
  RULE_RRN,
  RULE_CARD,
  RULE_EMAIL,
  RULE_IPV4,
  RULE_PHONE,
  RULE_ACCOUNT,
  PII_RULES,
  validateKoreanRRN,
  validateLuhn,
  validateIPv4,
  createPiiMaskContext,
  maskText,
  maskMessages,
  restoreText,
  restoreJsonPayload,
  createStreamRestorer,
} from '../privacy/index.mjs';

// Everything else the gate and the rest of the app use.
export * from '../privacy/index.mjs';

// LIMITATION NOTICE:
// On-disk session transcripts written independently by the OMP runtime (e.g. inside
// $PI_CODING_AGENT_DIR/sessions/*.jsonl) are NOT covered by this outbound/inbound
// gateway path. This pass intercepts requests at the inference/upstream gateway boundary.
