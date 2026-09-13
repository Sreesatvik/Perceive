// Phase D.3 / Step 4 — audit log chain viewer. Loads a JSONL file locally
// (no server dependency — File API only), parses each line, and verifies
// the hash chain using verifyAuditChainJs (dashboardUtils.js), which is a
// byte-for-byte port of server/app/logger.py's verify_audit_chain /
// server/app/verify_audit_chain.py — see extension/tests/test-dashboard-utils.js
// for the cross-language parity tests proving the two agree on real output.
//
// IMPORTANT: the audit log is a single GLOBAL append-only file shared
// across every session (documented in logger.py) — the hash chain links
// consecutive entries in write order regardless of session_id. So the
// chain is always verified over the FULL file, in file order; the session
// filter only controls which rows are DISPLAYED, never which are chained.
import { verifyAuditChainJs, GENESIS_HASH } from './dashboardUtils.js';

const fileInput = document.getElementById('log-file-input');
const sessionFilterInput = document.getElementById('session-filter');
const fileNameLabel = document.getElementById('file-name');
const chainStatusEl = document.getElementById('chain-status');
const emptyState = document.getElementById('empty-state');
const tableWrap = document.getElementById('table-wrap');
const rowsEl = document.getElementById('log-rows');

let allEntries = [];
let chainResult = { ok: true, brokenIndex: null };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function shortHash(h) {
  if (typeof h !== 'string') return String(h);
  return h === GENESIS_HASH ? 'GENESIS' : `${h.slice(0, 10)}…`;
}

function summarizeAction(action) {
  if (!action || typeof action !== 'object') return '';
  if (action.event_type) {
    const { event_type, ...rest } = action;
    const restStr = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    return `<span class="event-badge">${escapeHtml(event_type)}</span>${escapeHtml(restStr)}`;
  }
  if (action.error) return `<span style="color:#f08a8a;">error: ${escapeHtml(action.error)}</span>`;
  if (action.event) return `<span class="event-badge">${escapeHtml(action.event)}</span>`;
  if (action.type) return `${escapeHtml(action.type)}${action.risk_tier ? ` (${escapeHtml(action.risk_tier)})` : ''}`;
  return escapeHtml(JSON.stringify(action));
}

function render() {
  const filter = sessionFilterInput.value.trim();

  if (chainResult.ok) {
    chainStatusEl.className = 'ok';
    chainStatusEl.textContent = `CHAIN OK — ${allEntries.length} entries verified, unbroken from genesis to tip.`;
  } else {
    chainStatusEl.className = 'broken';
    chainStatusEl.textContent = `CHAIN BROKEN at entry index ${chainResult.brokenIndex} (the ${chainResult.brokenIndex + 1}${ordinalSuffix(chainResult.brokenIndex + 1)} line of the file) — tampering, deletion, or reordering detected. Everything from this entry onward cannot be trusted.`;
  }
  chainStatusEl.style.display = 'block';

  const visible = filter ? allEntries.filter((e) => e.session_id === filter) : allEntries;

  rowsEl.innerHTML = visible.map((entry) => {
    const globalIndex = allEntries.indexOf(entry);
    const rowBroken = !chainResult.ok && globalIndex >= chainResult.brokenIndex;
    return `
      <tr class="${rowBroken ? 'row-broken' : ''}">
        <td>${globalIndex}</td>
        <td>${escapeHtml(entry.step_number)}</td>
        <td>${escapeHtml((entry.session_id || '').slice(0, 12))}</td>
        <td>${entry.instruction_hash ? '<span class="event-badge">decision</span>' : ''}</td>
        <td>${summarizeAction(entry.action)}</td>
        <td class="hash-cell">${escapeHtml(shortHash(entry.previous_hash))}</td>
        <td class="hash-cell">${escapeHtml(shortHash(entry.entry_hash))}</td>
        <td class="${rowBroken ? 'row-status-broken' : 'row-status-ok'}">${rowBroken ? 'BROKEN' : 'ok'}</td>
      </tr>`;
  }).join('');

  emptyState.style.display = allEntries.length ? 'none' : 'block';
  tableWrap.style.display = allEntries.length ? 'block' : 'none';
}

function ordinalSuffix(n) {
  const j = n % 10, k = n % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileNameLabel.textContent = file.name;

  const text = await file.text();
  allEntries = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return { session_id: '(unparseable line)', action: { error: 'invalid JSON on this line' }, previous_hash: null, entry_hash: null };
      }
    });

  chainResult = await verifyAuditChainJs(allEntries);
  render();
});

sessionFilterInput.addEventListener('input', render);
