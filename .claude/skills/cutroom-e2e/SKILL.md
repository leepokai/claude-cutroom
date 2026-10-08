---
name: cutroom-e2e
description: End-to-end check for the Cutroom plugin. Use after changing anything under hooks/, types/, tests/ or player/, before saying a Cutroom change is done, or when the user says "e2e", "測一下 cutroom", "跑測試".
---

# Cutroom e2e

Run all three steps from the repo root. Stop at the first failure, fix it, and run again.

1. **Static + unit**: `claude plugin validate . && claude plugin test .`
   (The PostToolUse hook in `.claude/settings.json` already runs this after every edit; run it again here so the result is in front of you.)
2. **Headless load**: make sure a fixture project exists, then run `/cut` through a fresh engine:
   ```bash
   F="${TMPDIR:-/tmp}/cutroom-e2e"; [ -f "$F/demo/hyperframes.json" ] || (mkdir -p "$F" && cd "$F" && HYPERFRAMES_SKIP_SKILLS=1 npx -y hyperframes init demo --example warm-grain --non-interactive)
   cd "$F" && claude -p "/cut demo" --plugin-dir "$OLDPWD" < /dev/null
   ```
   Pass: the output contains `Cutroom:` and the project path. Fail: an error line, or a `cutroom: ... refused` / `did not load` line.
3. **Live session**: the desktop app hot-reloads this folder on save (`CLAUDE_CODE_PLUGIN_DIR_WATCH=1` in `~/.claude/settings.json`, loaded through the `~/.claude/skills/cutroom` symlink). Ask the user to type `/cut demo` in their session and send a screenshot of the pane. Do not claim the pane works until they confirm.

Report each step as pass/fail with the failing output.
