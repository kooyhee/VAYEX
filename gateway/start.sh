#!/bin/sh
# User-space launcher for the deployment host. No sudo, no service manager:
# `systemd --user` runs zero units there, so a foreground process or tmux session
# is the real deployment form.
#
# The shell's soft open-file limit is 1024 against a hard limit of 1048576.
# Concurrent SSE relays hold roughly two descriptors each, so this raises the
# soft limit before Node starts. server.mjs makes the same attempt in-process
# and reports the effective limits at startup either way.

set -eu

CONFIG="${1:-${GATEWAY_CONFIG:-./gateway.config.json}}"
TARGET_FDS="${GATEWAY_OPEN_FILES:-65535}"

if [ -n "${TARGET_FDS}" ]; then
  # `ulimit` is a shell builtin: no privileges required to raise up to the hard limit.
  ulimit -n "${TARGET_FDS}" 2>/dev/null || echo "warning: could not raise the open-file limit to ${TARGET_FDS}; continuing with the inherited limit" >&2
fi
echo "open-file limit (shell): soft=$(ulimit -n) hard=$(ulimit -Hn)"

exec node "$(dirname "$0")/server.mjs" --config "${CONFIG}"
