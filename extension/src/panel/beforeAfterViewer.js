// Phase D.3 / Step 3 — before/after screenshot viewer. Pure local File API
// use (webkitdirectory folder pickers) — no network, no server dependency.
// Pairing logic is the tested, pure matchBeforeAfterPairs() from
// dashboardUtils.js (extension/tests/test-dashboard-utils.js).
import { matchBeforeAfterPairs } from './dashboardUtils.js';

const redactedInput = document.getElementById('redacted-input');
const originalInput = document.getElementById('original-input');
const redactedStatus = document.getElementById('redacted-status');
const originalStatus = document.getElementById('original-status');
const emptyState = document.getElementById('empty-state');
const container = document.getElementById('pairs-container');

let redactedFiles = [];
let originalFiles = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function render() {
  const pairs = matchBeforeAfterPairs(redactedFiles, originalFiles);

  emptyState.style.display = pairs.length ? 'none' : 'block';
  container.innerHTML = pairs.map((pair) => {
    const redactedUrl = pair.redacted ? URL.createObjectURL(pair.redacted) : null;
    const originalUrl = pair.original ? URL.createObjectURL(pair.original) : null;
    return `
      <div class="pair-card">
        <div class="pair-header">Step <b>${escapeHtml(pair.step)}</b></div>
        <div class="images-row">
          <div class="image-col">
            <div class="label">Original (pre-redaction — only present if demo mode was on)</div>
            ${originalUrl ? `<img src="${originalUrl}" alt="Original screenshot, step ${escapeHtml(pair.step)}">` : '<div class="missing">no original captured for this step (demo mode off, or not saved)</div>'}
          </div>
          <div class="image-col">
            <div class="label">Redacted (what actually crossed the wire)</div>
            ${redactedUrl ? `<img src="${redactedUrl}" alt="Redacted screenshot, step ${escapeHtml(pair.step)}">` : '<div class="missing">no redacted artifact saved for this step</div>'}
          </div>
        </div>
      </div>`;
  }).join('');
}

redactedInput.addEventListener('change', () => {
  redactedFiles = Array.from(redactedInput.files).filter((f) => /_redacted\.png$/i.test(f.name));
  redactedStatus.textContent = `Redacted folder: ${redactedFiles.length} file(s) matched *_redacted.png`;
  render();
});

originalInput.addEventListener('change', () => {
  originalFiles = Array.from(originalInput.files).filter((f) => /_original\.png$/i.test(f.name));
  originalStatus.textContent = `Original folder: ${originalFiles.length} file(s) matched *_original.png`;
  render();
});
