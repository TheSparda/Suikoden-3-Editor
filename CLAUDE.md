# Repo conventions for AI sessions

## Authorship & attribution (required)

All Git and GitHub activity in this repository must be attributed to the repo
owner, **TheSparda** — never to "Claude" or any AI assistant.

- **Commits:** author and committer must be
  `TheSparda <310395642+TheSparda@users.noreply.github.com>`.
  A SessionStart hook (`.claude/hooks/session-start.sh`) sets this automatically
  in Claude Code on the web sessions; do not override it.
- **Do NOT add** any `Co-Authored-By: Claude …`, `Claude-Session:`, or similar
  AI-attribution trailers to commit messages.
- **Do NOT add** "Generated with Claude Code" (or any AI-attribution) footers to
  pull request descriptions, PR comments, reviews, or issue comments.

Keep commit messages, PR bodies, and code comments free of any AI/model
identifiers.
