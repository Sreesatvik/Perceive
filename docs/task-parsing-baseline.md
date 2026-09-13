# Task-Parsing Baseline (Phase C.1)

Measured, not estimated: `dev2/task-parsing-stress-test.mjs` run against
the **unmodified** `dev2/task-entity-extractor.js`, before any Phase C fix.
Raw per-case output: `docs/task-parsing-baseline.json`.

## Result: 10/27 correct (37%)

| # | Phrasing | Classification | What actually happened |
|---|---|---|---|
| 1 | log in with username tomsmith and password Password123 | CORRECT | |
| 2 | sign in, my username is tomsmith and password is Password123 | CORRECT | |
| 3 | use tomsmith / Password123 to log in | CORRECT | |
| 4 | log me in | CORRECT | `UnresolvedSensitiveReferenceError` raised, as intended |
| 5 | fill in the form with name Priya Shah, email priya@x.com, phone 9876543210 | **NO_MATCH** | Module has zero name/email/phone extraction — all three pass through raw. Email/phone are separately caught downstream by `pii-patterns.js`'s generic regex sweep; **name is not caught anywhere in the pipeline** |
| 6 | update my phone number to 9876543210 | NO_MATCH | Phone unrecognized by this module (caught downstream by `detectPII`) |
| 7 | check my most recent transaction | CORRECT | Read-only, passes through, no throw |
| 8 | click submit | CORRECT | |
| 9 | please can you log into my account for me | **NO_MATCH — SEVERE** | `impliesCredentialNeed`'s regex `\blog\s*in\b` does not match **"log into"** (word boundary fails between "in" and "to") — login intent isn't recognized at all, so no `UNRESOLVED` is raised and the task **silently proceeds with zero credentials** |
| 10 | could you kindly sign into the site using my email priya@x.com and password Secret!23 | NO_MATCH (partial) | Password tokenized correctly; email identifier untokenized by this module (works out only because `detectPII` separately catches the EMAIL shape downstream) |
| 11 | log in using my usr tomsmith and pwd Password123 | **NO_MATCH — real leak** | "pwd" matched, "usr" did not (not a recognized synonym) → username `tomsmith` left **completely raw and untokenized**, and it is not PII-shaped, so nothing downstream catches it either |
| 12 | enter username: tomsmith, password: Password123 | NO_MATCH | Colon-delimited `label:` style entirely unsupported |
| 13 | sign in with my account tom.smith@example.com / Passw0rd! | **HALLUCINATED/misassigned** | Password token captures `Passw0rd` but drops the trailing `!` — that character leaks raw into the sanitized text right next to the token (`[PASSWORD_2]!`) |
| 14 | update my email address to newmail@example.com | NO_MATCH | Unsupported by this module (caught downstream) |
| 15 | change my name to Priya Shah | NO_MATCH | Unsupported anywhere in the pipeline — no downstream fallback for NAME shape |
| 16 | log in — usename is tomsmith, paswrod is Password123 | NO_MATCH | Typo'd labels (`usename`/`paswrod`) unrecognized; throws `UNRESOLVED` with a message implying no value exists at all, when really it's a synonym gap |
| 17 | please log me into my saved account | **NO_MATCH — SEVERE** | Same "log ... into" word-boundary bug as #9 |
| 18 | sign in as tomsmith | NO_MATCH (imprecise) | Username was findable in isolation but the all-or-nothing design discards that partial finding and throws a generic "no credential value could be found" message |
| 19 | type Password123 into the password field | **HALLUCINATED (serious)** | Tokenizes the word **"field"** as the password value; the real value `Password123` (appearing *before* the label) is missed entirely |
| 20 | fill username field with tomsmith | **HALLUCINATED (serious)** | Same bug — tokenizes "field" as the username; real value `tomsmith` missed |
| 21 | log in with my usual credentials | CORRECT | `UNRESOLVED` correctly raised — no concrete value present |
| 22 | sign in using tom and 12345 | NO_MATCH (imprecise) | A real, unambiguous pair is present but the informal pattern's anchor-adjacency requirement isn't satisfied ("using" isn't a recognized anchor word); throws `UNRESOLVED` |
| 23 | complete the checkout without logging in | CORRECT (coincidental) | Passes through — but only because "logging in" *also* fails the same word-boundary bug as #9/#17, not because negation is actually handled |
| 24 | view my order history | CORRECT | |
| 25 | my username's tomsmith, and my password's Password123 | NO_MATCH | Possessive contractions unrecognized |
| 26 | please enter phone number 9876543210 and email priya@x.com to register | NO_MATCH | Unsupported by this module (both caught downstream) |
| 27 | log in with User ID tomsmith and Pass Password123 | CORRECT | Capitalized synonyms already covered by the existing `/i` flag |

## Failure mode tally

| Mode | Count | Cases |
|---|---|---|
| Correct | 10 | 1,2,3,4,7,8,21,23*,24,27 |
| No match found | 13 | 5,6,9,10,12,14,15,16,17,18,22,25,26 |
| Value hallucinated/misassigned | 3 | 13,19,20 |
| No match + real raw-value leak | 1 | 11 |

\* #23 is correct only by coincidence — same underlying bug as #9/#17, not deliberate negation handling.

## The two most important findings

1. **`impliesCredentialNeed`'s regex silently fails on "log into"** (#9, #17,
   and coincidentally #23). This is worse than a missed extraction — it
   means the module doesn't even recognize that a login was requested, so
   `UNRESOLVED_SENSITIVE_REFERENCE` never fires and the task **silently
   proceeds** with no credentials at all. This directly violates this
   phase's own Definition of Done ("never a silent wrong guess").
2. **Two genuine hallucinations** (#19, #20): "type X into the Y field"
   phrasing (value-before-label) causes the unquoted-value regex to grab
   the word immediately following the label — which is "field", not the
   real value sitting earlier in the sentence.
