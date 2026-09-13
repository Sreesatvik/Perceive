# Task-Parsing Fast-Path Fix — Before/After (Phase C.2b)

Same 27-phrasing stress test (`dev2/task-parsing-stress-test.mjs`), run
again after the Phase C.2(a)/(b) fixes to `dev2/task-entity-extractor.js`.
Raw results: `docs/task-parsing-after-fastpath-fix.json`. Baseline:
`docs/task-parsing-baseline.md` / `.json`.

## Result: 26/27 correct (96%), up from 10/27 (37%)

### What changed in `task-entity-extractor.js`

1. **`impliesCredentialNeed`'s regex fixed** — `\blog\s*in\b` didn't match
   "log **into**" (no word boundary between "in" and "to"). This was the
   single worst baseline finding: it meant the module never even attempted
   credential extraction for that phrasing, silently proceeding instead of
   raising `UnresolvedSensitiveReferenceError`. Fixed with an optional
   `(?:to)?` directly after "in".
2. **Two real hallucinations fixed** — "type X into the Y field" and "fill
   Y field with X" both grabbed the word "field" itself as the value (the
   real value, appearing before or with noise before the label, was
   missed). Fixed by adding dedicated value-before-label patterns tried
   first, plus a stopword backstop (`GENERIC_CONTINUATION_STOPWORDS`) that
   rejects "field"/"box"/"input"/etc. as a captured value regardless.
3. **A value-truncation leak fixed** — a password ending in `!` (e.g.
   `Passw0rd!`) had its `!` excluded from the capture group, leaking that
   character raw into the sanitized output right next to the token.
4. **Email/phone/name extraction added** — previously entirely absent
   (only documented as synonyms, never wired into extraction). Multi-field
   forms ("name X, email Y, phone Z") are now tokenized in one pass.
5. **Label synonyms broadened**: common misspellings/abbreviations (`usr`,
   `uname`, `pswd`, `passwrd`), colon-delimited (`label: value`) and
   possessive (`label's value`) connectives, and an additional informal
   pattern for `"sign in using X and Y"` phrasing.
6. **A critical regression found and fixed *during this same fix***: the
   bare `name` synonym matched as a *substring* of "user**name**" with no
   word-boundary guard, causing an already-inserted token to be
   re-tokenized (`[NAME_3]` wrapping `[NAME_1]`). Fixed by wrapping every
   label alternation in `\b...\b`.
7. Also found and fixed while re-running the stress test against this
   very fix: "update my phone number **to** 9876543210" hallucinated on
   the word "to" (value-after-"to" phrasing wasn't covered) — added a
   dedicated `updateFieldToValuePattern`.

### The one remaining fast-path gap

**#16, typo'd labels** (`"usename is tomsmith, paswrod is Password123"`)
still fails to extract — `usename`/`paswrod` aren't in the synonym list,
and full fuzzy/edit-distance matching wasn't implemented this session
(explicit scope decision, not an oversight — see report). Critically, it
still **fails closed**: `UnresolvedSensitiveReferenceError` is raised, not
a silent wrong guess or a crash. This is exactly the case the Phase
C.2(c) server-mediated fallback and C.2(d) explicit-prompt tiers exist to
catch next.
