#!/bin/sh
# macOS development-preview launcher. Only this process and its children receive
# the resolved runtime paths; no software is installed and no config is changed.
set -eu

case "${1-}" in
  server) entry=server.mjs ;;
  hook) entry=hooks/capture.mjs ;;
  *) printf '%s\n' 'CPM_LAUNCH_USAGE: expected server or hook' >&2; exit 64 ;;
esac
shift
case "$0" in */*) launch_directory=${0%/*} ;; *) launch_directory=. ;; esac
plugin_directory=$(CDPATH= cd "$launch_directory" && pwd -P)

node_ready() {
  [ -f "$1" ] && [ -x "$1" ] || return 1
  "$1" --experimental-sqlite -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12)) process.exit(2);
    try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.close(); }
    catch { process.exit(3); }
  ' >/dev/null 2>&1
}

node_binary=
if [ "${CPM_NODE_BIN+x}" = x ]; then
  case "$CPM_NODE_BIN" in
    /*) if [ ! -f "$CPM_NODE_BIN" ] || [ ! -x "$CPM_NODE_BIN" ]; then
          printf '%s\n' 'CPM_NODE_OVERRIDE_INVALID: CPM_NODE_BIN must name an executable file at an absolute path' >&2; exit 78
        fi ;;
    *) printf '%s\n' 'CPM_NODE_OVERRIDE_INVALID: CPM_NODE_BIN must be an absolute path' >&2; exit 78 ;;
  esac
  if ! node_ready "$CPM_NODE_BIN"; then
    printf '%s\n' 'CPM_NODE_RUNTIME_UNSUPPORTED: Node.js 22.12+ with working node:sqlite is required' >&2; exit 78
  fi
  node_binary=$CPM_NODE_BIN
else
  path_node=$(command -v node 2>/dev/null || :)
  for candidate in "$path_node" \
    "/opt/homebrew/opt/node@24/bin/node" "/opt/homebrew/opt/node@22/bin/node" "/opt/homebrew/bin/node" \
    "/usr/local/opt/node@24/bin/node" "/usr/local/opt/node@22/bin/node" "/usr/local/bin/node"; do
    case "$candidate" in /*) ;; *) continue ;; esac
    if node_ready "$candidate"; then node_binary=$candidate; break; fi
  done
  if [ -z "$node_binary" ]; then
    printf '%s\n' 'CPM_NODE_NOT_FOUND: install Node.js 22.12+ with node:sqlite, or set CPM_NODE_BIN to its absolute executable path' >&2; exit 78
  fi
fi

# GUI apps may have a restricted PATH. Extend only the launched process tree.
PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
export PATH
if [ "${CPM_CODEX_BIN+x}" = x ]; then
  case "$CPM_CODEX_BIN" in
    /*) if [ ! -f "$CPM_CODEX_BIN" ] || [ ! -x "$CPM_CODEX_BIN" ]; then
          printf '%s\n' 'CPM_CODEX_OVERRIDE_INVALID: CPM_CODEX_BIN must name an executable file at an absolute path' >&2; exit 78
        fi ;;
    *) printf '%s\n' 'CPM_CODEX_OVERRIDE_INVALID: CPM_CODEX_BIN must be an absolute path' >&2; exit 78 ;;
  esac
else
  path_codex=$(command -v codex 2>/dev/null || :)
  for candidate in "$path_codex" \
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" \
    "${HOME:-/nonexistent}/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"; do
    case "$candidate" in /*) ;; *) continue ;; esac
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then CPM_CODEX_BIN=$candidate; export CPM_CODEX_BIN; break; fi
  done
fi
export CPM_NODE_BIN="$node_binary"
exec "$node_binary" --experimental-sqlite "$plugin_directory/$entry" "$@"
