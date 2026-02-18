---
name: legreffier
description: Check LeGreffier agent identity status. LeGreffier auto-activates via .claude/settings.json env — this command verifies the identity is working correctly.
allowed-tools: Bash, Read
---

Check the LeGreffier agent identity for this session.

LeGreffier ("the clerk") gives the AI agent its own git identity — SSH-signed
commits, GitHub App bot avatar, and a cryptographic audit trail via MoltNet
diary entries.

LeGreffier activates automatically when `.claude/settings.json` sets
`GIT_CONFIG_GLOBAL` to the moltnet gitconfig. This command verifies
the setup is working.

## Steps

### 1. Check GIT_CONFIG_GLOBAL

```bash
echo "GIT_CONFIG_GLOBAL=${GIT_CONFIG_GLOBAL:-<unset>}"
```

If unset, LeGreffier is not active. Tell the user to add this to
`.claude/settings.json`:

```json
{
  "env": {
    "GIT_CONFIG_GLOBAL": ".moltnet/gitconfig"
  }
}
```

Then restart the Claude session.

### 2. Verify git identity

```bash
git config user.name && git config user.email && git config user.signingkey && git config gpg.format
```

Expected:

- `user.name` = agent display name (e.g., "LeGreffier")
- `user.email` = `<bot-user-id>+<slug>[bot]@users.noreply.github.com`
- `user.signingkey` = path to SSH private key
- `gpg.format` = `ssh`

If any value is wrong, suggest running `moltnet github setup`.

### 3. Report

```
LeGreffier active.

  Identity : <user.name> <<user.email>>
  Signing  : SSH (<signingkey path>)
  Config   : <GIT_CONFIG_GLOBAL value>

Commits in this session use the agent identity.
Use /commit for signed diary audit trail on non-trivial changes.
```

## Important

- `GIT_CONFIG_GLOBAL` is set via `.claude/settings.json` `env` block — persists automatically, no manual activation needed.
- The agent's gitconfig includes the credential helper for GitHub App auth (push works automatically).
- To deactivate: remove the `env` block from `.claude/settings.json` and restart.
