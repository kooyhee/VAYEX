// Passive SSE reader. It never rewrites a frame: the bytes go to the client
// untouched, and this parser only extracts what the quota ledger needs.

import { usageBreakdown } from './accounting.mjs';

export class SseUsageParser {
  constructor() {
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.tokens = null;
    // The last complete breakdown a provider reported, cache read/write included.
    // `reported: false` means "unknown", never "free".
    this.breakdown = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, reported: false, source: 'none' };
    this.frames = 0;
    this.malformedFrames = 0;
    this.errorFrames = 0;
    this.sawDone = false;
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.consume(line);
      index = this.buffer.indexOf('\n');
    }
  }

  consume(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      this.sawDone = true;
      return;
    }
    this.frames += 1;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      this.malformedFrames += 1;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      this.malformedFrames += 1;
      return;
    }
    if (event.error) this.errorFrames += 1;
    const reported = usageBreakdown(event.usage);
    if (reported.reported) {
      this.breakdown = reported;
      this.tokens = reported.total;
    }
  }
}
