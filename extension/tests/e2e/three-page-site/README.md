# Phase F three-page test site

Plain static HTML/CSS/JS, no build step, no framework — the deliberate
"teaching-material" scenario used throughout this project: log in, view an
account balance rendered only in a `<canvas>` (zero DOM cooperation), then
update a phone number.

## Pages

- **login.html** — plain username/password form. Any non-empty
  username+password succeeds and redirects to `dashboard.html`.
- **dashboard.html** — renders `Balance: $4,281.50` via real
  `CanvasRenderingContext2D.fillText()` — there is no DOM-visible text, `alt`
  attribute, `title`, `aria-label`, or hidden element anywhere on the page
  carrying that number. The only way to read it is the vision/OCR channel.
  Links to `profile.html`.
- **profile.html** — a phone-number field + "Update" button. Update
  completes immediately (no OTP gate).
- **profile-otp.html** — the OTP-gated variant (Phase F / Step 2): clicking
  "Update" reveals a previously-hidden "Enter the code sent to your phone"
  field before the update can complete, simulating an OTP requirement
  appearing mid-flow that the original task instruction could not have
  anticipated.

## Running locally

No build step needed — serve the folder with any static file server, e.g.:

```bash
cd extension/tests/e2e/three-page-site
python -m http.server 8080
```

Then open `http://localhost:8080/login.html`.

## Use in a live Phase F run

1. Happy path: `login.html` -> log in -> `dashboard.html` (confirm the
   dashboard's Vision findings count and audit log show the balance was
   detected/redacted via OCR) -> click through to `profile.html` -> update
   the phone number.
2. OTP variant: same flow but navigate to `profile-otp.html` instead of
   `profile.html`, and give the task instruction WITHOUT mentioning any
   code (e.g. "update my phone number to 9876543210") — confirm the
   extension pauses with an unresolved/OTP-specific message instead of
   guessing a code, per `dev2/task-entity-extractor.js`'s
   `checkForUnanticipatedOtpField()`.
