# CLAUDE.md — fair-dice

A provably fair dice roller with cryptographic audit trail. Built entirely by LeGreffier to demonstrate accountable AI commits.

## Identity

This project uses LeGreffier as the commit author. Launch with `npm run legreffier` — this sets `GIT_CONFIG_GLOBAL` and loads MCP credentials in one command.

Run `/legreffier` to check identity status.

## Commit Rules

- **Never** add `Co-Authored-By` trailers. LeGreffier is the author, not a co-author.
- Use conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Use `/commit` for all commits. It classifies risk automatically — medium/high-risk changes get a signed diary entry, low-risk changes get a normal commit.

## Launch

```bash
npm run legreffier
```

## Project

- Node.js CLI dice roller with ASCII art
- Single `index.html` web UI with Canvas animation
- Cryptographic fairness proof (commitment scheme)
- `/investigate` skill for querying the agent's diary
