import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from './redact.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Structured JSON lines. Every record goes through the redactor and the serialised
// line is redacted a second time, so a secret nested inside a provider message
// cannot escape through an escape sequence in the JSON encoding.
export function createLogger(options = {}) {
  const level = LEVELS[options.level] ? options.level : 'info';
  const filePath = options.filePath || null;
  const redactor = options.redactor || createRedactor();
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function emit(recordLevel, event, fields = {}) {
    if (LEVELS[recordLevel] < LEVELS[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: recordLevel,
      event,
      ...redactor.value(fields),
    };
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: recordLevel, event, serialisation_error: true });
    }
    line = redactor.text(line);
    if (filePath) {
      try {
        fs.appendFileSync(filePath, `${line}\n`);
      } catch (error) {
        stderr.write(`gateway log write failed: ${error.message}\n`);
      }
    }
    stdout.write(`${line}\n`);
  }

  return {
    level,
    filePath,
    redactor,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child(bound, customScrubber = null) {
      const activeScrubber = customScrubber || redactor;
      const withBound = (fn) => (event, fields) => fn(event, { ...bound, ...fields });
      function emitChild(recordLevel, event, fields = {}) {
        if (LEVELS[recordLevel] < LEVELS[level]) return;
        const scrubbedFields = activeScrubber ? activeScrubber.value(fields) : fields;
        const record = {
          ts: new Date().toISOString(),
          level: recordLevel,
          event,
          ...scrubbedFields,
        };
        let line;
        try {
          line = JSON.stringify(record);
        } catch {
          line = JSON.stringify({ ts: record.ts, level: recordLevel, event, serialisation_error: true });
        }
        line = redactor.text(line);
        if (filePath) {
          try {
            fs.appendFileSync(filePath, `${line}\n`);
          } catch (error) {
            stderr.write(`gateway log write failed: ${error.message}\n`);
          }
        }
        stdout.write(`${line}\n`);
      }
      return {
        level,
        redactor: activeScrubber,
        debug: withBound((e, f) => emitChild('debug', e, f)),
        info: withBound((e, f) => emitChild('info', e, f)),
        warn: withBound((e, f) => emitChild('warn', e, f)),
        error: withBound((e, f) => emitChild('error', e, f)),
        child: (more, moreScrubber) => (createLogger({ ...options, redactor })).child({ ...bound, ...more }, moreScrubber || activeScrubber),
      };
    },
  };
}
