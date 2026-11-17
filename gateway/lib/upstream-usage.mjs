// Usage is only ever taken from what the provider reported. A missing or
// partial usage block returns null, which callers must record as "unknown" and
// never as zero.

export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const total = usage.total_tokens;
  if (Number.isFinite(total) && total >= 0) return Math.trunc(total);
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
    return Math.trunc(prompt + completion);
  }
  return null;
}
