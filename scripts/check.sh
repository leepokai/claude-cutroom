#!/bin/bash
# PostToolUse hook: after an edit inside this repo, validate + test the plugin.
# Exit 2 sends the failure back to Claude.
root="$(cd "$(dirname "$0")/.." && pwd)"
f="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')"
case "$f" in "$root"/hooks/*|"$root"/types/*|"$root"/tests/*|"$root"/player/*|"$root"/.claude-plugin/plugin.json) ;; *) exit 0 ;; esac
cd "$root"
out="$( { claude plugin validate . && claude plugin test . ; } 2>&1 )" || { echo "cutroom check failed after editing $f:" >&2; echo "$out" | tail -40 >&2; exit 2; }
exit 0
