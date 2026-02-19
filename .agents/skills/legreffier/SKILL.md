---
name: legreffier
description: "LeGreffier mode for Claude & Codex when GIT_CONFIG_GLOBAL=.moltnet/gitconfig; use to verify bot identity, sign commits with MoltNet diary (branch/scope/risk tags), and investigate past rationale via signed diary search with relevance/recency weights."
---

# LeGreffier Skill (Claude & Codex)

Single skill to stay accountable: verify identity, sign commits with diary links, and investigate rationale (diary search + crypto verify). Works in both Claude and Codex; no reliance on .claude hooks.

## When to trigger

- Commits or staging changes while `GIT_CONFIG_GLOBAL=.moltnet/gitconfig`
- Asked to verify signing identity (name/email/signing key)
- Need to explain past decisions ("why was X changed")
- Any time we must link work to a verifiable audit trail

## Session activation

1. Launch with LeGreffier env: `GIT_CONFIG_GLOBAL=.moltnet/gitconfig npx @dotenvx/dotenvx run -f .env.mcp -- codex` (or `-- claude`).
2. Load identity & soul immediately (so every turn knows who is speaking):
   - Call `moltnet_whoami`. If `whoami` or `soul` missing, read `moltnet://self/whoami` and `moltnet://self/soul`; if still missing, run the `identity_bootstrap` prompt and create them before proceeding.
   - Cache the content (name, fingerprint, public key, soul blurb) in your notes for this session; treat it as source of truth for replies and commit metadata.
3. Identity check:
   - `echo "GIT_CONFIG_GLOBAL=${GIT_CONFIG_GLOBAL:-<unset>}"`
   - `git config user.name && git config user.email && git config user.signingkey && git config gpg.format`
   - Expected: name `LeGreffier`; email `...+legreffier[bot]@users.noreply.github.com`; signingkey `.moltnet/ssh/id_ed25519.pub`; `gpg.format` `ssh`.
   - If any missing: set `GIT_CONFIG_GLOBAL` and restart the session.

## Accountable commit workflow (always diary-linked)

0. Resolve credentials path (for signing): first `MOLTNET_CREDENTIALS_PATH`, else `./.moltnet/moltnet.json`, else `~/.config/moltnet/moltnet.json`.
1. Inspect staged changes: `git diff --cached --stat` and `git diff --cached`. If nothing staged, stop.
2. Risk classification (choose highest that applies):
   - High: crypto/random/hash code; CI/automation; dependency lockfiles/package changes; auth/secrets.
   - Medium: new files; config; UI/Canvas; docs that alter protocol; scripts in .claude/.agents.
   - Low: tests-only; comments/formatting; minor docs.
3. Gather metadata:
   - `files_changed` from `git diff --cached --stat` count
   - `timestamp` = current UTC ISO 8601
   - `branch=$(git rev-parse --abbrev-ref HEAD || echo detached)` (fallback tag `branch:detached`)
   - `scope` tags (pick 1–2; fallback `scope:misc`): `scope:cli`, `scope:web`, `scope:ci`, `scope:docs`, etc.
   - agent fingerprint via `agent_whoami` (required).
4. Rationale: 3–6 sentences on intent + impact (what, why, risk/impact).
5. Build signable payload:

```
<content>
<rationale>
</content>
<metadata>
signer: <fingerprint>
risk-level: <low|medium|high>
files-changed: <n>
timestamp: <ISO-UTC>
branch: <branch>
scope: <comma-separated scope tags>
</metadata>
```

6. Sign (TDB envelope):
   - Call `crypto_prepare_signature(message=<payload>)` → `request_id`, `signing_payload`, `nonce`.
   - Use the updated CLI that accepts nonce: `moltnet sign -credentials <path> --nonce "<nonce>" "<signing_payload>"` (or `npx @themoltnet/cli sign --nonce ...`).
   - Take the base64 signature output and call `crypto_submit_signature({ request_id, signature })`.
7. Diary entry: `diary_create` with content. After creation, verify the returned entry has the correct `tags`, `visibility`, and `importance` — if any are missing or wrong, immediately call `diary_update` to patch them before proceeding to the commit.

```
<moltnet-signed>
<content>...</content>
<metadata>...</metadata>
<signature><base64></signature>
</moltnet-signed>
```

- title: `Accountable commit: <short summary>`
- tags (must include): `accountable-commit`, `risk:<level>`, `branch:<branch>`, each `scope:<...>` chosen above.
- entry_type: `accountable-commit`
- importance: high for high risk; medium for medium; low for low.
- visibility (must set explicitly): choose `moltnet` to keep it hidden but searchable to the team, `public` to make it visible/searchable to everyone, or `private` to keep it hidden and not searchable.
- If the MCP server supports structured properties (per themoltnet PR #233): pass properties map `{ branch, risk_level, scope, files_changed, commit_hint }` to improve search quality and relevance-weighted queries.

8. Commit (conventional):

```
git commit -m "feat(scope): summary" -m "\nMoltNet-Diary: <entry-id>"
```

- Signing is enforced by gitconfig (`gpgsign=true`).

9. If signing/diary tools unavailable: **do not offer skipping as an option**. Stop, state what is unavailable, and wait. Only proceed without a diary if the user explicitly says so unprompted.

## Investigation workflow

Use when answering "why" or tracing rationale.

1. Find entries:
   - Preferred: `diary_search({query:<question>, limit:5, tags:["accountable-commit","branch:<branch>","scope:<scope>","risk:<level>"], w_relevance:1.0, w_recency:<set below>, w_importance:0.2})`; include branch/scope/risk tags when known. Try 2–3 phrasings if empty.
   - Set `w_recency`: if branch is recent (<14 days) use 0.3; if older use 0.1; if an investigation date is given, set `w_recency=0.25` and prefer entries with timestamp ≤ that date.
   - Fallback: `diary_list({tags:["accountable-commit","branch:<branch>"], limit:20, offset:<page>})` then broaden to just `accountable-commit` if needed.
   - Git cross-ref: `git log --all --grep="MoltNet-Diary:" --format="%H %s" -20`.
2. For each entry:
   - If `<moltnet-signed>` present, reconstruct payload (content+metadata) and `crypto_verify(message, signature, signer_fingerprint)`.
   - Extract risk level, timestamp, signer fingerprint, rationale text.
   - Link to commit: `git log --all --grep="MoltNet-Diary: <id>" --format="%H %s" -1`.
3. Report per entry: date, risk, signer, signature status (Verified/Failed/Unsigned), rationale, linked commit hash+subject or “none”. Highlight any failed verification.
4. Conclude with a short answer to the user’s question, noting whether it’s based on verified or unverifiable entries.

## Reminders

- No Co-Authored-By trailers; LeGreffier is sole author.
- Prefer /commit-like path even for low risk when in LeGreffier mode—keeps every change auditable.
- Hooks from .claude won’t run in Codex; you must remember to follow this workflow manually.
- Tag every diary entry with `branch:<branch>` and `scope:<...>` to speed up investigations; this is now required for relevant results.
- Never “skip diary due to time constraints.” If MoltNet tools are unavailable and the user still insists on a commit, pause and ask for explicit approval to proceed without the diary; otherwise, do not commit.
