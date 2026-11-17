// File-descriptor headroom. Every concurrent SSE relay holds two sockets (client
// and upstream) plus the log file, so the default soft limit of 1024 on the
// target host caps concurrency far below what the hardware allows. A process may
// raise its own soft limit up to the hard limit without privileges, which is the
// only lever available to a user-space start with no sudo.
//
// Node exposes getrlimit/setrlimit only through process.binding, and that binding
// is absent on some builds. So: try the binding, then read the ambient limits
// from /proc/self/limits on Linux, and report exactly what is in force. The
// shell launcher (start.sh) raises the soft limit with `ulimit -n` before exec,
// which is the path that always works.

import fs from 'node:fs';

export function parseProcLimits(text) {
  const line = String(text || '').split('\n').find((row) => row.startsWith('Max open files'));
  if (!line) return null;
  const numbers = line.replace('Max open files', '').trim().split(/\s+/);
  const soft = Number.parseInt(numbers[0], 10);
  const hard = Number.parseInt(numbers[1], 10);
  if (!Number.isFinite(soft) || !Number.isFinite(hard)) return null;
  return { soft, hard, source: '/proc/self/limits' };
}

export function readProcLimits(path = '/proc/self/limits') {
  try {
    return parseProcLimits(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function raiseFdLimit({ target = 65535 } = {}) {
  let binding = null;
  try {
    binding = process.binding('fd');
  } catch {
    binding = null;
  }

  if (binding && typeof binding.getFdLimit === 'function' && typeof binding.setFdLimit === 'function') {
    const before = binding.getFdLimit();
    const desired = Math.min(target, before.hard);
    if (before.soft >= desired) {
      return { supported: true, soft: before.soft, hard: before.hard, raised: false, source: 'process.binding', note: 'already at or above the requested limit' };
    }
    try {
      binding.setFdLimit(desired);
      const after = binding.getFdLimit();
      return {
        supported: true,
        soft: after.soft,
        hard: after.hard,
        raised: after.soft > before.soft,
        source: 'process.binding',
        note: after.soft > before.soft ? null : 'setrlimit did not change the soft limit',
      };
    } catch (error) {
      return {
        supported: true,
        soft: before.soft,
        hard: before.hard,
        raised: false,
        source: 'process.binding',
        note: `setrlimit failed: ${error.message}; raise it in the shell before start (ulimit -n ${desired})`,
      };
    }
  }

  // No in-process API. Report what the kernel says is in force so the operator
  // sees a real number instead of a guess.
  const ambient = readProcLimits();
  if (ambient) {
    return {
      supported: false,
      soft: ambient.soft,
      hard: ambient.hard,
      raised: false,
      source: ambient.source,
      note: 'this Node build has no setrlimit binding; start the gateway through start.sh, which runs `ulimit -n` before exec',
    };
  }
  return {
    supported: false,
    soft: null,
    hard: null,
    raised: false,
    source: null,
    note: 'no rlimit source is readable on this platform (no process.binding("fd"), no /proc/self/limits); the effective limit is unknown, and the shell launcher is the only raise path',
  };
}

