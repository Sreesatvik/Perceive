// Phase D.3 — pure, unit-testable helpers backing the audit dashboard, the
// before/after screenshot viewer, and the audit-chain viewer. Kept separate
// from auditDashboard.js/auditLogViewer.js/beforeAfterViewer.js (which are
// DOM-wiring only) specifically so this logic can be covered by real,
// non-browser unit tests.

/**
 * Phase B's real, honest current state (docs/vision-engine-decision.md):
 * OCR is strong; face detection measured at 39.1% recall / 60% precision
 * at default config in real Chrome, with an accuracy-improvement experiment
 * PREPARED but not yet run. The dashboard must never collapse this into a
 * single "vision: available" flag that overstates confidence in face
 * detection specifically.
 *
 * @param {{ faceDetectionFailed: boolean, ocrFailed: boolean }} status
 */
export function summarizeVisionStatus({ faceDetectionFailed, ocrFailed }) {
  return {
    ocr: ocrFailed ? 'OCR: unavailable (engine error this step)' : 'OCR: active',
    faceDetection: faceDetectionFailed
      ? 'Face detection: unavailable (engine error this step)'
      : 'Face detection: active (accuracy not yet validated — 39.1% recall @ default config, Phase B)',
  };
}

/**
 * @param {{elements?: Array}} domSummary
 * @param {Array<{method: string}>} confidenceNotes
 */
export function countFindings(domSummary, confidenceNotes) {
  const domFindings = Array.isArray(domSummary?.elements)
    ? domSummary.elements.filter((el) => el.is_sensitive).length
    : 0;
  const visionFindings = Array.isArray(confidenceNotes)
    ? confidenceNotes.filter((n) => n.method === 'vision_model' || n.method === 'ocr_regex').length
    : 0;
  return { domFindings, visionFindings };
}

/**
 * "Raw PII transmitted" must always read as blocked/zero in the normal
 * case — leakage-auditor.js's assertSafeToSend() throws BEFORE the network
 * call if it ever finds one, so a successful send is itself proof nothing
 * leaked. If FIREWALL_BLOCK fired this step, the request never reached the
 * server at all (a good outcome — the firewall did its job) but is
 * distinct enough to call out rather than rendering identically to the
 * normal "nothing to block" case.
 * @param {boolean} firewallBlockedThisStep
 */
export function summarizeRawPiiStatus(firewallBlockedThisStep) {
  return firewallBlockedThisStep
    ? 'BLOCKED — leakage-auditor rejected this payload pre-send (0 raw values transmitted)'
    : 'blocked (0 raw values transmitted)';
}

/**
 * Matches before/after screenshot files by step number, given two flat
 * lists of File objects (as produced by an <input type="file" webkitdirectory>
 * picker) — one from Part 1's server-side artifact folder
 * (server/artifacts/{session}/{N}_redacted.png) and one from the D.1b
 * demo-mode download folder (perceive-demo/{session}/{N}_original.png).
 * @param {File[]} redactedFiles
 * @param {File[]} originalFiles
 * @returns {Array<{step: number, redacted: File|null, original: File|null}>} sorted by step
 */
export function matchBeforeAfterPairs(redactedFiles, originalFiles) {
  const byStep = new Map();

  const extractStep = (name, suffix) => {
    const match = new RegExp(`(\\d+)_${suffix}\\.png$`).exec(name);
    return match ? parseInt(match[1], 10) : null;
  };

  for (const f of redactedFiles || []) {
    const step = extractStep(f.name, 'redacted');
    if (step === null) continue;
    if (!byStep.has(step)) byStep.set(step, { step, redacted: null, original: null });
    byStep.get(step).redacted = f;
  }
  for (const f of originalFiles || []) {
    const step = extractStep(f.name, 'original');
    if (step === null) continue;
    if (!byStep.has(step)) byStep.set(step, { step, redacted: null, original: null });
    byStep.get(step).original = f;
  }

  return Array.from(byStep.values()).sort((a, b) => a.step - b.step);
}

// --- Audit-chain verification, reimplemented in JS ---
//
// Mirrors server/app/logger.py's _compute_entry_hash/verify_audit_chain
// EXACTLY, since this runs in a browser extension page with no Python
// available. The two things that must match byte-for-byte with Python's
// json.dumps(entry_without_hash, sort_keys=True):
//   1. Key order: sorted lexicographically (JS: sort keys ourselves,
//      JSON.stringify does NOT sort object keys on its own).
//   2. Separators: Python's default (no `indent`) is ", " and ": " —
//      comma-space and colon-space — NOT JSON.stringify's compact ",", ":".
//   3. Non-ASCII escaping: Python's json.dumps defaults to ensure_ascii=True,
//      which \uXXXX-escapes every non-ASCII character. JSON.stringify does
//      not. canonicalJsonStringify below replicates this explicitly so a
//      unicode task_instruction/label doesn't silently produce a mismatched
//      hash against the real Python-computed entry_hash.
export const GENESIS_HASH = '0'.repeat(64);

function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return escapeAsciiJsonString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(', ') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${escapeAsciiJsonString(k)}: ${canonicalJsonStringify(value[k])}`);
  return '{' + parts.join(', ') + '}';
}

function escapeAsciiJsonString(str) {
  let out = '"';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x09) out += '\\t';
    else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        // surrogate pair, matching Python's ensure_ascii output for
        // characters outside the BMP
        const c = code - 0x10000;
        const hi = 0xd800 + (c >> 10);
        const lo = 0xdc00 + (c & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeEntryHash(entryWithoutHash, previousHash) {
  const serialized = canonicalJsonStringify(entryWithoutHash);
  return sha256Hex(serialized + previousHash);
}

/**
 * JS port of server/app/logger.py's verify_audit_chain(). Returns
 * {ok, brokenIndex} exactly like the Python function returns (True, None)
 * or (False, i).
 * @param {object[]} entries
 */
export async function verifyAuditChainJs(entries) {
  let expectedPreviousHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      if (!('entry_hash' in entry) || !('previous_hash' in entry)) return { ok: false, brokenIndex: i };
      if (entry.previous_hash !== expectedPreviousHash) return { ok: false, brokenIndex: i };

      const entryWithoutHash = {};
      for (const k of Object.keys(entry)) {
        if (k !== 'entry_hash') entryWithoutHash[k] = entry[k];
      }
      const recomputed = await computeEntryHash(entryWithoutHash, entry.previous_hash);
      if (recomputed !== entry.entry_hash) return { ok: false, brokenIndex: i };

      expectedPreviousHash = entry.entry_hash;
    } catch (_e) {
      return { ok: false, brokenIndex: i };
    }
  }
  return { ok: true, brokenIndex: null };
}
