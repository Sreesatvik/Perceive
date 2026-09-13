# Face detection accuracy fixtures (Phase B.2 / B.5)

25 images (31 ground-truth faces), hand-labeled ground truth in
`manifest.json`. Expanded from the original 15 (23 ground-truth faces) in
Phase B.5's Step 0: `occluded` and `id_card` were each raised from 1 to 5
fixtures, and `zero_face` from 3 to 5, so single-fixture categories aren't
over-weighted in the aggregate recall/precision numbers. **Results measured
against the 15-fixture set and the 25-fixture set are not directly
comparable** — see `docs/vision-accuracy/face-detection-results.json`,
which keeps both as separate, clearly-labeled entries rather than treating
them as one continuous series.

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

## Category breakdown (20 real photos + 5 synthetic modifications)

| Category | Files | Real or synthetic |
|---|---|---|
| frontal | frontal_1..4.jpg | Real (NASA) |
| angled | angled_1..3.jpg | Real (NASA) |
| small/distant | small_distant_1.jpg | Real (NASA) |
| multiple faces | multiple_faces_1.jpg (2 faces), multiple_faces_2.jpg (8 faces) | Real (NASA) |
| zero-face control | zero_face_1..5.jpg | Real (NASA) |
| occluded | occluded_1..5.jpg | **Real photos, synthetic occlusion bar** — see manifest notes |
| ID card | id_card_1..5.jpg | **Fully synthetic composites** — see manifest notes |

Every synthetic image is a real, disclosed NASA photo with a synthetic
*modification* on top (an occlusion bar, or a card layout wrapped around a
cropped face) — no real face photo was substituted with a synthetic one.
Built with one-off Node scripts (`_build_synthetic.cjs` for the original
batch, `_build_synthetic_batch2.cjs` for the Step 0 expansion — both run
once and deleted, not committed, since they're generators, not reusable
test infrastructure). `occluded_1..5.jpg` each draw a solid bar over the
source photo's eye region; `id_card_1..5.jpg` each composite a face crop
onto a programmatically-drawn card layout (fake placeholder text only — no
real PII, e.g. `ID NO: 0000-0000-0000`).

## Ground truth format

`manifest.json` is a JSON array; each entry has `file`, `category`,
`source`, optional `note`, and `expected_faces`: an array of
`{"box": [x, y, w, h]}` with all four values as **fractions of image
width/height** (0.0-1.0), hand-labeled by visual inspection — approximate,
not pixel-exact, as instructed. `small_distant_1.jpg` labels only the 4
most clearly identifiable faces out of 15+ visible people; see its `note`.
