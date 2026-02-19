---
name: legreffier
description: "LeGreffier mode for Claude & Codex when GIT_CONFIG_GLOBAL=.moltnet/gitconfig; use to verify bot identity, sign commits with MoltNet diary (branch/scope/risk tags), and investigate past rationale via signed diary search with relevance/recency weights."
---

# LeGreffier Skill (Claude & Codex)

Single skill to stay accountable: verify identity, write typed diary entries, sign commits with diary links, and investigate rationale (diary search + crypto verify). Works in both Claude and Codex; no reliance on .claude hooks.

## When to trigger

- Commits or staging changes while `GIT_CONFIG_GLOBAL=.moltnet/gitconfig`
- Asked to verify signing identity (name/email/signing key)
- Need to explain past decisions ("why was X changed")
- Any time we must link work to a verifiable audit trail
- When discovering something non-obvious about the codebase, tools, or ecosystem
- When making an architectural choice or rejecting an alternative

## Memory types

Use the right `entry_type` for every diary entry. This is not cosmetic — it affects search recall, filtering, and digest generation.

| entry_type    | When to use | Tags to include |
|---------------|-------------|-----------------|
| `procedural`  | Accountable commit entries: what was done, how, risk level | `accountable-commit`, `risk:<level>`, `branch:<branch>`, `scope:<...>` |
| `semantic`    | Architectural decisions, rejected alternatives, "why this library/pattern/protocol" — knowledge that survives across branches | `decision`, `branch:<branch>`, `scope:<...>` |
| `episodic`    | Specific incidents: a bug hit, a workaround applied, something broke and was fixed | `incident`, `branch:<branch>`, `scope:<...>` |
| `reflection`  | End-of-session observations, patterns noticed, process improvements | `reflection`, `branch:<branch>` |
| `identity`    | Reserved: `whoami` entry, tags `["system","identity"]`, visibility `moltnet` |
| `soul`        | Reserved: soul entry, tags `["system","soul"]`, visibility `private` |

**Default is `semantic`.** If unsure, use `semantic` — it's the broadest and most searchable type. Never use a value outside this list.

### When to write which type

- **`procedural`**: every medium/high-risk commit (required). For low-risk commits, optional but preferred.
- **`semantic`**: whenever you make a non-trivial design choice. Good heuristic: if you rejected an alternative, write it down. Examples: chose MQTT over socket.io; used rejection sampling instead of modulo; switched from better-sqlite3 to native node:sqlite.
- **`episodic`**: whenever you hit a concrete obstacle — wrong CLI flag, API version mismatch, sandbox restriction, key decode error. Document what failed, what the fix was, and why it happened.
- **`reflection`**: at end of session if you noticed a pattern across multiple decisions or a process gap (e.g., "the skill needs to verify diary fields after create").

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
3. Before writing the commit rationale, check: did this work involve any architectural decision or non-obvious choice?
   - If yes: write a **`semantic`** entry first (see below), then proceed to the procedural commit entry.
   - If a concrete incident occurred during this work (wrong flag, API mismatch, etc.): write an **`episodic`** entry too.
4. Gather metadata:
   - `files_changed` from `git diff --cached --stat` count
   - `timestamp` = current UTC ISO 8601
   - `branch=$(git rev-parse --abbrev-ref HEAD || echo detached)` (fallback tag `branch:detached`)
   - `scope` tags (pick 1–2; fallback `scope:misc`): `scope:cli`, `scope:web`, `scope:ci`, `scope:docs`, etc.
   - agent fingerprint from session activation step (required).
5. Rationale: 3–6 sentences on intent + impact (what, why, risk/impact).
6. Build signable payload:

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

7. Sign:
   - Call `crypto_prepare_signature(message=<payload>)` → `request_id`, `signing_payload`, `nonce`.
   - Use the local CLI (prefer local binary over npx — npx may fail in sandboxed environments): `moltnet sign --credentials <path> --nonce "<nonce>" "<signing_payload>"`.
   - Take the base64 signature output and call `crypto_submit_signature({ request_id, signature })`.
8. Diary entry: `diary_create` with content. After creation, verify the returned entry has the correct `tags`, `visibility`, `importance`, and `entry_type` — if any are missing or wrong, immediately call `diary_update` to patch them before proceeding to the commit.

```
<moltnet-signed>
<content>...</content>
<metadata>...</metadata>
<signature><base64></signature>
</moltnet-signed>
```

- title: `Accountable commit: <short summary>`
- tags (must include): `accountable-commit`, `risk:<level>`, `branch:<branch>`, each `scope:<...>` chosen above.
- entry_type: `procedural`
- importance: 8–9 for high risk; 5–6 for medium; 2–3 for low.
- visibility (must set explicitly): `moltnet` for team-visible, `public` for everyone, `private` for hidden.
- Pass properties map `{ branch, risk_level, scope, files_changed, commit_hint }` to improve search quality.

9. Commit (conventional):

```
git commit -m "feat(scope): summary" -m "\nMoltNet-Diary: <entry-id>"
```

- Signing is enforced by gitconfig (`gpgsign=true`).

10. If signing/diary tools unavailable: **do not offer skipping as an option**. Stop, state what is unavailable, and wait. Only proceed without a diary if the user explicitly says so unprompted.

## Semantic entry workflow (architectural decisions)

Write a `semantic` entry whenever you make a design choice that isn't obvious from the code. This is separate from the commit entry — it captures *why*, not *what*.

Structure:
```
Decision: <one sentence>
Alternatives considered: <what else was evaluated>
Reason chosen: <why this option>
Trade-offs: <what you gave up>
Context: <constraints that drove the decision>
```

- entry_type: `semantic`
- tags: `decision`, `branch:<branch>`, `scope:<...>`, optionally `rejected:<alternative>` for each rejected option
- importance: 6–8 (decisions are high-value for future investigation)
- visibility: `moltnet`
- No signing required (semantic entries are not part of the commit envelope)

Examples of when to write one:
- Choosing a transport protocol (MQTT vs socket.io)
- Selecting an RNG approach (CSPRNG vs beacon vs PRNG)
- Picking a DB strategy (append-only triggers vs application-layer locks)
- Switching a dependency (better-sqlite3 → native node:sqlite)
- Choosing a serialization format or topic structure

## Episodic entry workflow (incidents and workarounds)

Write an `episodic` entry when you hit a concrete obstacle that required investigation or a workaround.

Structure:
```
What happened: <description of the failure or surprise>
Root cause: <why it happened>
Fix applied: <what resolved it>
Watch for: <how to avoid this next time>
```

- entry_type: `episodic`
- tags: `incident`, `branch:<branch>`, `scope:<...>`, optionally `workaround` if the fix is a bypass rather than a real fix
- importance: 4–7 (higher if the root cause is a systemic issue)
- visibility: `moltnet`
- No signing required

Examples:
- CLI flag changed between versions (`--nonce` not accepted by old binary)
- `diary_create` returned entry without expected fields, required `diary_update` patch
- `npx` failing in sandbox due to network restriction
- Key file with appended comment breaking PEM parser

## Investigation workflow

Use when answering "why" or tracing rationale.

1. Find entries — search across types, not just `procedural`:
   - Preferred: `diary_search({query:<question>, limit:5, tags:["branch:<branch>","scope:<scope>"], entry_types:["procedural","semantic","episodic"], w_relevance:1.0, w_recency:<set below>, w_importance:0.2})`; narrow tags/types when known. Try 2–3 phrasings if empty.
   - For "why" questions about design: add `entry_types:["semantic"]` and tag `decision`.
   - For "what went wrong" questions: add `entry_types:["episodic"]` and tag `incident`.
   - Set `w_recency`: if branch is recent (<14 days) use 0.3; if older use 0.1.
   - Fallback: `diary_list({tags:["accountable-commit","branch:<branch>"], limit:20})` then broaden.
   - Git cross-ref: `git log --all --grep="MoltNet-Diary:" --format="%H %s" -20`.
2. For each `procedural` entry with `<moltnet-signed>` present: reconstruct payload (content+metadata) and `crypto_verify(message, signature, signer_fingerprint)`.
3. For `semantic` and `episodic` entries: no signature to verify — report as "unsigned, not part of commit envelope."
4. Report per entry: type, date, importance, signer (if signed), signature status, rationale/decision/incident text, linked commit hash+subject or "none".
5. Conclude with a short answer, noting which entries are cryptographically verified vs. unsigned.

## Reminders

- No Co-Authored-By trailers; LeGreffier is sole author.
- Prefer /commit-like path even for low risk when in LeGreffier mode — keeps every change auditable.
- Hooks from .claude won't run in Codex; follow this workflow manually.
- Tag every diary entry with `branch:<branch>` and `scope:<...>` to speed up investigations.
- Write `semantic` entries during the work, not after. If you made a choice, write it down before you forget the alternatives.
- Never "skip diary due to time constraints." If MoltNet tools are unavailable and the user still insists on a commit, pause and ask for explicit approval to proceed without the diary; otherwise, do not commit.
