# Face detection accuracy fixtures (Phase B.2)

15 images, hand-labeled ground truth in `manifest.json`.

## Sourcing / licensing decision

All real photos are sourced from **images.nasa.gov** (NASA's official image
library). NASA content is a work of the U.S. federal government and is
public domain in the United States (17 U.S.C. § 105) — no license
ambiguity. Exact `nasa_id` and title are recorded per-file in
`manifest.json`'s `source` field for traceability.

**Committed to git, not gitignored**: the full fixture set is ~2.3MB total.
That's small enough that repo bloat isn't a real concern, and every image's
license is unambiguous, so there's no legal reason to exclude them either.
Committing them (rather than gitignoring) was a deliberate choice: it's
what makes the accuracy numbers in `docs/vision-accuracy/` actually
reproducible by anyone who clones the repo — a gitignored fixture set would
make the committed results unverifiable.

## Category breakdown (13 real photos + 2 synthetic)

| Category | Files | Real or synthetic |
|---|---|---|
| frontal | frontal_1..4.jpg | Real (NASA) |
| angled | angled_1..3.jpg | Real (NASA) |
| small/distant | small_distant_1.jpg | Real (NASA) |
| multiple faces | multiple_faces_1.jpg (2 faces), multiple_faces_2.jpg (8 faces) | Real (NASA) |
| zero-face control | zero_face_1..3.jpg | Real (NASA) |
| occluded | occluded_1.jpg | **Real photo, synthetic occlusion bar** — see manifest note |
| ID card | id_card_1.jpg | **Fully synthetic composite** — see manifest note |

The two synthetic images were built with a one-off Node script
(`_build_synthetic.cjs`, run once and deleted — not committed, since it's
not reusable test infrastructure, just a generator). To regenerate them:
the script drew a solid bar over `frontal_2.jpg`'s eye region for
`occluded_1.jpg`, and composited a face crop from `frontal_3.jpg` onto a
programmatically-drawn card layout for `id_card_1.jpg` (fake placeholder
text only — no real PII).

No real face photos were substituted with synthetic ones in this set —
only the *occlusion bar* and the *card layout* are synthetic additions on
top of real face photos, which is disclosed per-image in `manifest.json`.

## Ground truth format

`manifest.json` is a JSON array; each entry has `file`, `category`,
`source`, optional `note`, and `expected_faces`: an array of
`{"box": [x, y, w, h]}` with all four values as **fractions of image
width/height** (0.0-1.0), hand-labeled by visual inspection — approximate,
not pixel-exact, as instructed. `small_distant_1.jpg` labels only the 4
most clearly identifiable faces out of 15+ visible people; see its `note`.
