---
name: investigate
description: Investigate past agent decisions with cryptographic proof. Searches diary entries, verifies signatures, and links findings to git commits.
allowed-tools: Bash(git log *), Bash(git show *)
argument-hint: Your question about the codebase (e.g., "why is Math.random not used?")
---

Investigate past agent decisions using the MoltNet diary audit trail.

This skill searches the agent's diary for entries matching a question,
verifies their cryptographic signatures, and links them back to git commits.

## Input

The user's question is: $ARGUMENTS

## Steps

### 1. Multi-strategy diary search

Semantic search can miss relevant entries due to embedding limitations.
Use multiple strategies to maximize recall.

#### 1a. Semantic search (primary)

Try 2-3 different query phrasings to work around embedding blind spots:

```
diary_search({ query: "<user's question verbatim>", limit: 5 })
```

If that returns 0 results, rephrase the query using synonyms or different
angles. For example, if the user asks "how deps are audited", also try:
- "dependency vulnerabilities security"
- "npm audit pre-commit hook"
- "package security scanning"

#### 1b. Tag-based listing (fallback)

If semantic search returns nothing useful, browse entries by tag.
Accountable commits use the tags `["accountable-commit", "<risk-level>"]`.
Tags use AND semantics — entries must have ALL specified tags.

```
diary_list({ tags: ["accountable-commit"], limit: 20 })
```

You can also combine tags to narrow results:

```
diary_list({ tags: ["accountable-commit", "high"], limit: 20 })
```

You can also combine semantic search with tag filtering:

```
diary_search({ query: "<user's question>", tags: ["accountable-commit"], limit: 10 })
```

This is often the most effective strategy — it constrains semantic search
to only accountable-commit entries, avoiding noise from unrelated diary entries.

#### 1c. Paginated browsing (last resort)

If there are more entries than the first page returns, paginate:

```
diary_list({ limit: 20, offset: 0 })
diary_list({ limit: 20, offset: 20 })
```

Scan until you find relevant entries or exhaust all pages.

#### 1d. Git log cross-reference

As a parallel strategy, search git history for commits with diary links:

```bash
git log --all --grep="MoltNet-Diary:" --format="%H %s" -20
```

This shows all accountable commits. For each, the commit message contains
the diary entry ID that can be fetched directly.

### 2. Process each entry

For each relevant diary entry found via any strategy:

#### 2a. Check for a signed envelope

Look for the `<moltnet-signed>` TDB envelope in the entry content.
If present, extract the three blocks:

- `<content>...</content>` — the rationale
- `<metadata>...</metadata>` — signer fingerprint, risk level, files changed, timestamp
- `<signature>...</signature>` — base64 Ed25519 signature

#### 2b. Verify the signature

If a signed envelope is found:

1. Reconstruct the signing payload (everything from `<content>` opening tag
   through `</metadata>` closing tag, inclusive)
2. Extract the `signer:` fingerprint from the `<metadata>` block
3. Verify:

```
crypto_verify({
  message: "<content>\n...\n</content>\n<metadata>\n...\n</metadata>",
  signature: "<base64 signature>",
  signer_fingerprint: "<fingerprint from metadata>"
})
```

**If the metadata has no `signer:` field** (older entries created before this
fix), fall back to the current agent's fingerprint via `agent_whoami`. Note
this in the output — verification is best-effort for legacy entries.

Record the result: verified, failed, or unverifiable (no signer info).

#### 2c. Find the linked commit

Search git log for commits referencing this diary entry's ID:

```bash
git log --all --grep="MoltNet-Diary: <entry-id>" --format="%H %s" -1
```

If found, show the commit hash and message.

### 3. Present findings

For each relevant entry, present:

```
## Finding: <entry title or short description>

**Date:** <timestamp from metadata or entry>
**Risk level:** <from metadata>
**Signer:** <fingerprint>
**Signature:** Verified / FAILED / Unsigned / Unverifiable (legacy)

**Rationale:**
<content from the signed envelope, or entry content if unsigned>

**Commit:** <hash> — <message>  (or "No linked commit found")
```

### 4. Flag issues

If any signature verification fails, prominently warn:

```
WARNING: Entry "<title>" has a FAILED signature verification.
This means the content may have been tampered with after signing.
The original rationale cannot be trusted.
```

### 5. Summarize

End with a brief answer to the user's original question, synthesized
from the verified diary entries. Distinguish between verified and
unverified sources. Mention the search strategy that found the results
if semantic search initially failed.

## When MCP tools are unavailable

If `diary_search` or `crypto_verify` are not available (no MCP connection),
inform the user:

```
The MoltNet MCP server is not connected. To investigate past decisions,
start Claude with MCP credentials:

  npm run claude
```

## Example output

```
Found 2 diary entries about "why crypto.randomBytes"
(found via semantic search, query: "cryptographic random number generation")

## Finding: Accountable commit: use crypto.randomBytes for dice

**Date:** 2026-02-17T14:30:00Z
**Risk level:** high
**Signer:** 1671-B080-99BF-4270
**Signature:** Verified

**Rationale:**
Switched from Math.random() to crypto.randomBytes() for the dice roller.
Math.random() is not cryptographically secure and its output is predictable
given enough samples. For a provably fair dice game, we need a CSPRNG.

**Commit:** a1b2c3d — feat(dice): use crypto.randomBytes for fair rolls

---

The agent chose crypto.randomBytes because Math.random() is not
cryptographically secure. This decision was signed and verified,
confirming the rationale is authentic.
```
