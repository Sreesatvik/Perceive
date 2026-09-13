import assert from 'assert';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  summarizeVisionStatus,
  countFindings,
  summarizeRawPiiStatus,
  matchBeforeAfterPairs,
  verifyAuditChainJs,
  GENESIS_HASH,
} from '../src/panel/dashboardUtils.js';

console.log('=== RUNNING PHASE D.3 DASHBOARD-UTILS TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

async function runAsyncTestCase(name, fn) {
  totalCount++;
  try {
    await fn();
    passCount++;
    console.log(`[PASS] Test ${totalCount}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${totalCount}: ${name}\n  Error: ${err.message}`);
    throw err;
  }
}

// --- summarizeVisionStatus: honest wording, never a single collapsed flag ---

await runAsyncTestCase('summarizeVisionStatus: both engines healthy -> OCR active, face detection active-but-unvalidated (not a blanket "available")', async () => {
  const status = summarizeVisionStatus({ faceDetectionFailed: false, ocrFailed: false });
  assert.strictEqual(status.ocr, 'OCR: active');
  assert.ok(status.faceDetection.includes('active'), 'must say active');
  assert.ok(status.faceDetection.includes('not yet validated'), 'must not overstate face-detection confidence');
  assert.ok(status.faceDetection.includes('39.1'), 'must cite the real Phase B recall number, not a vague qualifier');
});

await runAsyncTestCase('summarizeVisionStatus: face detection engine failed this step -> reported unavailable, independent of OCR', async () => {
  const status = summarizeVisionStatus({ faceDetectionFailed: true, ocrFailed: false });
  assert.ok(status.faceDetection.includes('unavailable'));
  assert.strictEqual(status.ocr, 'OCR: active', 'OCR failing independently of face detection must not cross-contaminate the OCR status');
});

await runAsyncTestCase('summarizeVisionStatus: OCR engine failed this step -> reported unavailable, independent of face detection', async () => {
  const status = summarizeVisionStatus({ faceDetectionFailed: false, ocrFailed: true });
  assert.ok(status.ocr.includes('unavailable'));
  assert.ok(status.faceDetection.includes('active'));
});

// --- countFindings ---

await runAsyncTestCase('countFindings: counts sensitive DOM elements and vision/OCR confidence notes separately', async () => {
  const domSummary = { elements: [{ is_sensitive: true }, { is_sensitive: false }, { is_sensitive: true }] };
  const notes = [
    { method: 'dom_heuristic' },
    { method: 'vision_model' },
    { method: 'ocr_regex' },
    { method: 'vision_model' },
  ];
  const { domFindings, visionFindings } = countFindings(domSummary, notes);
  assert.strictEqual(domFindings, 2);
  assert.strictEqual(visionFindings, 3);
});

await runAsyncTestCase('countFindings: handles missing/empty domSummary and confidenceNotes without throwing', async () => {
  const { domFindings, visionFindings } = countFindings(undefined, undefined);
  assert.strictEqual(domFindings, 0);
  assert.strictEqual(visionFindings, 0);
});

// --- summarizeRawPiiStatus ---

await runAsyncTestCase('summarizeRawPiiStatus: normal step reads blocked/zero', async () => {
  assert.strictEqual(summarizeRawPiiStatus(false), 'blocked (0 raw values transmitted)');
});

await runAsyncTestCase('summarizeRawPiiStatus: a firewall block this step is reported distinctly, still as a block (never as a leak)', async () => {
  const msg = summarizeRawPiiStatus(true);
  assert.ok(msg.includes('BLOCKED'));
  assert.ok(msg.includes('0 raw values transmitted'));
});

// --- matchBeforeAfterPairs ---

function fakeFile(name) {
  return { name };
}

await runAsyncTestCase('matchBeforeAfterPairs: matches redacted+original files by step number, sorted', async () => {
  const redacted = [fakeFile('2_redacted.png'), fakeFile('1_redacted.png')];
  const original = [fakeFile('1_original.png'), fakeFile('2_original.png')];
  const pairs = matchBeforeAfterPairs(redacted, original);
  assert.strictEqual(pairs.length, 2);
  assert.strictEqual(pairs[0].step, 1);
  assert.strictEqual(pairs[0].redacted.name, '1_redacted.png');
  assert.strictEqual(pairs[0].original.name, '1_original.png');
  assert.strictEqual(pairs[1].step, 2);
});

await runAsyncTestCase('matchBeforeAfterPairs: a redacted-only step (no demo-mode original captured) still appears with original: null', async () => {
  const pairs = matchBeforeAfterPairs([fakeFile('5_redacted.png')], []);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].redacted.name, '5_redacted.png');
  assert.strictEqual(pairs[0].original, null);
});

await runAsyncTestCase('matchBeforeAfterPairs: ignores files that do not match the expected naming pattern', async () => {
  const pairs = matchBeforeAfterPairs([fakeFile('not_a_match.png')], [fakeFile('also_bad.jpg')]);
  assert.strictEqual(pairs.length, 0);
});

// --- verifyAuditChainJs: genesis + tamper detection ---

await runAsyncTestCase('verifyAuditChainJs: empty chain verifies clean (trivial case)', async () => {
  const { ok, brokenIndex } = await verifyAuditChainJs([]);
  assert.strictEqual(ok, true);
  assert.strictEqual(brokenIndex, null);
});

await runAsyncTestCase('verifyAuditChainJs: a chain with a broken previous_hash link is caught at the right index', async () => {
  const entries = [
    { previous_hash: GENESIS_HASH, entry_hash: 'doesnotmatter-but-must-fail-differently' },
    { previous_hash: 'wrong-link', entry_hash: 'x' },
  ];
  // First entry's stored entry_hash will legitimately fail the recompute
  // check (it's a placeholder), so this exercises brokenIndex === 0.
  const { ok, brokenIndex } = await verifyAuditChainJs(entries);
  assert.strictEqual(ok, false);
  assert.strictEqual(brokenIndex, 0);
});

// --- Cross-language correctness: the JS reimplementation must agree with
// the REAL Python logger byte-for-byte, not just "look right". This is the
// single highest-risk part of dashboardUtils.js (see its own header
// comment on separators/ensure_ascii) so it's verified against a real
// server/app/logger.py run, not just hand-built fixtures. ---

function findServerRoot() {
  // extension/tests -> ../../server
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'server');
}

await runAsyncTestCase('verifyAuditChainJs agrees with the REAL Python logger on a genuine, unmodified chain (cross-language hash parity)', async () => {
  const serverRoot = findServerRoot();
  const pythonExe = path.join(serverRoot, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(pythonExe)) {
    console.warn('  SKIPPED (inner check): no server/.venv found in this environment — cannot cross-check against real Python output here.');
    return;
  }

  const tmpLog = path.join(os.tmpdir(), `perceive_dashboard_chain_test_${Date.now()}.jsonl`);
  const genScript = `
import sys
sys.path.insert(0, ${JSON.stringify(serverRoot)})
from app import logger as L
L.LOG_FILE = ${JSON.stringify(tmpLog)}
L._last_entry_hash = L.GENESIS_HASH
L.log_audit_event('dash-test-session', 1, "log in — usame's 'unicode' \\u00e9\\u00e8", {'type': 'click', 'risk_tier': 'safe'}, 0.9, [])
L.log_audit_event('dash-test-session', 2, 'submit', {'type': 'click', 'risk_tier': 'safe', 'value': None}, 0.9, [])
`;
  execFileSync(pythonExe, ['-c', genScript], { cwd: serverRoot });

  const entries = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  fs.unlinkSync(tmpLog);

  assert.strictEqual(entries.length, 2, 'expected the real logger to have written 2 entries');

  const { ok, brokenIndex } = await verifyAuditChainJs(entries);
  assert.strictEqual(brokenIndex, null, `JS verifier disagreed with Python's own real hashes at index ${brokenIndex} — canonical JSON serialization has drifted from logger.py`);
  assert.strictEqual(ok, true, 'the JS reimplementation must independently confirm a real, untampered Python-generated chain as clean');
});

await runAsyncTestCase('verifyAuditChainJs correctly flags a REAL Python-generated chain after it is tampered with on disk', async () => {
  const serverRoot = findServerRoot();
  const pythonExe = path.join(serverRoot, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(pythonExe)) {
    console.warn('  SKIPPED (inner check): no server/.venv found in this environment.');
    return;
  }

  const tmpLog = path.join(os.tmpdir(), `perceive_dashboard_chain_tamper_${Date.now()}.jsonl`);
  const genScript = `
import sys
sys.path.insert(0, ${JSON.stringify(serverRoot)})
from app import logger as L
L.LOG_FILE = ${JSON.stringify(tmpLog)}
L._last_entry_hash = L.GENESIS_HASH
L.log_audit_event('dash-test-session', 1, 'log in', {'type': 'click', 'risk_tier': 'safe'}, 0.9, [])
L.log_audit_event('dash-test-session', 2, 'submit', {'type': 'click', 'risk_tier': 'safe'}, 0.9, [])
L.log_audit_event('dash-test-session', 3, 'confirm', {'type': 'click', 'risk_tier': 'safe'}, 0.9, [])
`;
  execFileSync(pythonExe, ['-c', genScript], { cwd: serverRoot });

  const entries = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  fs.unlinkSync(tmpLog);

  entries[1].confidence = 0.0; // tamper with the middle (index 1) entry

  const { ok, brokenIndex } = await verifyAuditChainJs(entries);
  assert.strictEqual(ok, false);
  assert.strictEqual(brokenIndex, 1, `expected the break at the tampered entry (index 1), got ${brokenIndex}`);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} DASHBOARD-UTILS TESTS PASSED SUCCESSFULLY ---`);
