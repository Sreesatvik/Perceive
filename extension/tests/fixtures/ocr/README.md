# OCR accuracy fixtures (Phase B.3)

4 images, all **synthetically generated via `canvas` drawing** (a one-off
generator script, run once and deleted — not committed, same reasoning as
the face-fixtures' `_build_synthetic.cjs`). None of these are real
screenshots or real documents; ground truth text in `manifest.json` is
exact by construction (verified by visual inspection of each rendered
image before writing it down), not estimated.

| File | Category | What it tests |
|---|---|---|
| `clean_text_1.png` | clean printed text | Approximates "a screenshot of a normal webpage paragraph" — disclosed as canvas-rendered, not a literal browser screenshot, since no real webpage screenshot was captured this session. |
| `canvas_dashboard_1.png` | canvas dashboard | The central "zero DOM cooperation" scenario: a card-number-shaped PII string that exists only as canvas pixels. |
| `low_contrast_small_1.png` | low-contrast / small font | Light gray text (`#c9c9c9`) on near-white (`#f2f2f2`), 11px font. |
| `rotated_skewed_1.png` | rotated/skewed | Text rotated ~18°, within the requested 15-20° range. |

No real PII appears in any fixture — `4111-1111-1111-1111` and
`998-2201-4471` are synthetic placeholder values chosen to match a
card-number/reference-number *shape*, not real account data.
