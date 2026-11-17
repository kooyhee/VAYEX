// The on-disk half of the insight backend: read the documented JSONL event log
// (`gateway/lib/events.mjs`, one record per line) when one exists.
//
// Today nothing in this repository attaches that sink: `config.eventsPath` is
// parsed but never wired to `createJsonlSink`. The exact hook is reported in
// app/insight/README.md; until it is mounted, callers pass `events` explicitly
// and the route answers `source.reported: false` instead of inventing data.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveEventLogPath({ env = process.env, fallback = null } = {}) {
  const value = typeof env.AI_EVENTS_PATH === 'string' && env.AI_EVENTS_PATH.trim()
    ? env.AI_EVENTS_PATH.trim()
    : fallback;
  return typeof value === 'string' && value ? resolve(value) : null;
}

export function readEventLog(path) {
  if (!path) {
    return { events: [], skipped: 0, path: null, reported: false, reason: 'no_event_log_path' };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { events: [], skipped: 0, path, reported: false, reason: 'event_log_unreadable', message: error.message };
  }
  const events = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, path, reported: true, reason: null };
}
