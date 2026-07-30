# Project conventions

## Commit authorship

All commits are authored by the repository owner. Never add Claude attribution to
commits — no `Co-Authored-By: Claude`, no `Claude-Session:` trailer, no
`🤖 Generated with Claude Code` line, and never commit as the `Claude
<noreply@anthropic.com>` identity.

Before the first commit in a session, verify the author identity is correct:

```
git config user.name "jeremainecheong"
git config user.email "jeremainecheong01@gmail.com"
```

Commit messages describe the change only.
