#!/usr/bin/env bash
#
# Launch a command with AFK's reviewed PRD 4 environment baseline.
#
# Environment values remain in environment memory or a private pipe: this
# script starts a clean intermediate Bash, sends only approved key/value pairs
# over file descriptor 3, then execs the requested command. It never copies an
# environment value into an argument.
#
# This is a launch wrapper, not an OS sandbox. Descendants can still read files
# available to the operator and use the network.

set -euo pipefail

if (( $# == 0 )); then
  echo "usage: scripts/min-env.sh <command> [args...]" >&2
  exit 64
fi

emit_allowed_environment() {
  local key
  for key in \
    PATH \
    SYSTEMROOT \
    COMSPEC \
    PATHEXT \
    USERPROFILE \
    APPDATA \
    LOCALAPPDATA \
    TEMP \
    TMP \
    HOME \
    PNPM_HOME \
    NUMBER_OF_PROCESSORS
  do
    if [[ -v $key ]]; then
      printf '%s\0%s\0' "$key" "${!key}"
    fi
  done
}

readonly bash_path="$(type -P bash)"

exec -c "$bash_path" -c '
  while IFS= read -r -d "" key && IFS= read -r -d "" value; do
    printf -v "$key" "%s" "$value"
    export "$key"
  done <&3
  exec "$@"
' afk-min-env "$@" 3< <(emit_allowed_environment)
