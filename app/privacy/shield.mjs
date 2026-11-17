// Pre-scan shields: spans that look like personal data but cannot be.
//
// A detector that fires on `127.0.0.1`, a UUID, a git SHA, an SRI integrity hash
// or a `data:` URL is not being cautious, it is corrupting the request: masked
// code stops compiling and masked URLs stop resolving. These ranges are cut out
// of the text first; every detector skips anything inside one.

// Reserved documentation ranges: RFC 5737 (IPv4 testing) and RFC 3849 (IPv6
// documentation) never designate a real host, so they are not project data.
const LOOPBACK_HOSTS = ['127.0.0.1', '127.0.0.2', '0.0.0.0', 'localhost', '::1'];

const LOCAL_PATTERNS = [
  // RFC 5737 documentation blocks
  /\b192\.0\.2\.\d{1,3}\b/g,
  /\b198\.51\.100\.\d{1,3}\b/g,
  /\b203\.0\.113\.\d{1,3}\b/g,
  // Loopback in every spelling the app writes it
  /\b127\.0\.0\.\d{1,3}\b/g,
  /\b0\.0\.0\.0\b/g,
  /\blocalhost\b/gi,
  /\b::1\b/g,
];

const IDENTIFIER_PATTERNS = [
  // UUID / GUID, in every generation the repo emits
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // Git object ids (SHA-1 40 hex, SHA-256 64 hex), bare
  /\b[0-9a-f]{40}\b/g,
  /\b[0-9a-f]{64}\b/g,
  // Subresource-integrity digests
  /\bsha(?:256|384|512)-[A-Za-z0-9+/=]{16,}/g,
  // Integrity attributes inside HTML/JS strings
  /integrity\s*=\s*["'][^"']*["']/g,
  // data: URLs (inline images, fonts, fixtures) — opaque payloads, never PII text
  /data:[a-z0-9.+-]*\/[a-z0-9.+-]*;(?:charset|base64)[^\s"'`)<>]*/gi,
  // npm scopes: `@xenova/transformers` is a package, not an address
  /@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/g,
];

/**
 * Ranges (inclusive start, exclusive end) that detectors must not touch.
 * @param {string} text
 * @returns {{start:number,end:number,kind:string}[]}
 */
export function shieldRanges(text) {
  const source = String(text ?? '');
  if (!source) return [];
  const ranges = [];
  const groups = [
    ['loopback', LOCAL_PATTERNS],
    ['identifier', IDENTIFIER_PATTERNS],
  ];
  for (const [kind, patterns] of groups) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
        const start = match.index;
        let end = start + match[0].length;
        // `integrity="..."` shields its whole quoted value only; keep the range exact.
        ranges.push({ start, end, kind });
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  // Collapse overlaps so the skip test is one comparison per range group.
  return ranges;
}

/** True when `[start,end)` is fully contained in any shielded range. */
export function shielded(ranges, start, end) {
  for (const range of ranges ?? []) {
    if (start >= range.start && end <= range.end) return true;
  }
  return false;
}

/** True when the span overlaps a shielded range at all (partial containment is enough). */
export function overlapsShield(ranges, start, end) {
  for (const range of ranges ?? []) {
    if (start < range.end && end > range.start) return true;
  }
  return false;
}

export const SHIELD_HOSTS = Object.freeze(LOOPBACK_HOSTS);
