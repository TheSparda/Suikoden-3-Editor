#!/bin/bash
# SessionStart hook: pin the git author/committer identity to TheSparda for
# Claude Code on the web sessions, so commits made in cloud sessions are
# attributed to the repo owner rather than the default "Claude" identity.
#
# Repo-local only (never --global) and remote-only, so it can't clobber a
# contributor's own identity in a local checkout. Idempotent and silent.
set -euo pipefail

# Only act inside a remote (Claude Code on the web) session.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

repo="${CLAUDE_PROJECT_DIR:-$(pwd)}"
git -C "$repo" config user.name  "TheSparda"
git -C "$repo" config user.email "310395642+TheSparda@users.noreply.github.com"
