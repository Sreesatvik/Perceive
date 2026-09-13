/**
 * Phase C.4 — real, end-to-end proof of the server-mediated fallback
 * (C.2c): NOT a unit test against a mocked LLM (server/tests/test_field_mapping.py
 * already covers that layer) — this drives the REAL client-side extraction
 * logic against a REAL running backend making a REAL Groq LLM call, and
 * inspects the ACTUAL bytes sent over the wire.
 *
 * This is a genuine integration test, so it needs a live server
 * (server/app, real GROQ_API_KEY) reachable at BACKEND_URL. If none is
 * reachable, it SKIPS (exit 0, loud message) rather than failing a normal
 * `npm test` run in an environment without one — the correctness/privacy
 * assertions below only run for real when a server actually answers.
 *
 * Run manually with a live server up:
 *   cd server && source .venv/Scripts/activate && \
 *     AUDIT_LOG_FILE=audit_fallback_e2e.jsonl python -m uvicorn app.main:app --port 8000 &
 *   cd dev2 && node test-task-parsing-fallback-e2e.mjs
 */
import assert from 'assert';
import { resolveCredentialTokens, extractCandidateValueSlots } from './task-entity-extractor.js';
import crypto from 'crypto';

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const API_KEY = process.env.BACKEND_API_KEY || 'my-test-secret-123';
const CANDIDATE_PURPOSES = ['username', 'password', 'email', 'phone', 'name'];
const LATENCY_SAMPLE_COUNT = 8;

// Deliberately fast-path-defeating: no quoted values, no "label: value" or
// "label is value" structure adjacent to either value, and the
// username/password pair is joined by "and" but positioned mid-sentence —
// neither anchored far away from any recognized label synonym nor adjacent
// to "log in"/"sign in" the way the fast path's informal patterns require.
// Confirmed (see docs/task-parsing-baseline.md's methodology) that this
// phrase genuinely reaches resolveCredentialTokens()'s throw, not a
// silently-successful fast-path match.
const PHRASE = "I'd like to log in to the dashboard; my details are tomsmith and Password123, if that's still current.";

function mockVault() {
  const tokens = [];
  return {
    getOrCreateToken(raw, type) {
      const token = `[${type}_${crypto.randomBytes(4).toString('hex')}]`;
      tokens.push({ raw, type, token });
      return token;
    },
    tokens,
  };
}

async function serverIsReachable() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_e) {
    return false;
  }
}

async function runFallbackOnce(sessionId) {
  const slots = extractCandidateValueSlots(PHRASE);
  if (!slots) throw new Error('extractCandidateValueSlots found nothing for this phrase');

  const payload = {
    session_id: sessionId,
    task_instruction: slots.slotInstruction,
    step_number: 1,
    dom_summary: { url: 'https://example.com/login', elements: [] },
    field_mapping_request: {
      slot_ids: Object.keys(slots.slotValues),
      candidate_field_purposes: CANDIDATE_PURPOSES,
    },
  };
  const requestBody = JSON.stringify(payload);

  const t0 = Date.now();
  const response = await fetch(`${BACKEND_URL}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: requestBody,
  });
  const latencyMs = Date.now() - t0;
  const responseJson = await response.json();

  return { requestBody, responseJson, latencyMs, slots, status: response.status };
}

async function main() {
  console.log('=== Phase C.4: real end-to-end server-mediated fallback proof ===\n');

  if (!(await serverIsReachable())) {
    console.log(`SKIPPED — no live server reachable at ${BACKEND_URL}/health. This is a genuine integration test`);
    console.log('requiring a live server + real GROQ_API_KEY; it cannot run meaningfully without one.');
    console.log('See this file\'s header comment for how to start one and re-run.');
    process.exit(0);
  }

  let passCount = 0;
  let totalCount = 0;
  function check(name, fn) {
    totalCount++;
    try {
      fn();
      passCount++;
      console.log(`[PASS] ${name}`);
    } catch (err) {
      console.error(`[FAIL] ${name}\n  ${err.message}`);
      throw err;
    }
  }

  // (a) Confirm the fast path genuinely fails first — this phrase must
  // reach the fallback, not be silently resolved by (a)/(b).
  check('(a) fast path genuinely throws UnresolvedSensitiveReferenceError for this phrase', () => {
    assert.throws(() => resolveCredentialTokens(PHRASE, mockVault()), { name: 'UnresolvedSensitiveReferenceError' });
  });

  const { requestBody, responseJson, latencyMs, slots, status } = await runFallbackOnce(crypto.randomUUID());

  check('(b) the fallback fires and the real /analyze call succeeds (200)', () => {
    assert.strictEqual(status, 200, `expected 200, got ${status}: ${JSON.stringify(responseJson)}`);
  });

  check('(c) the ACTUAL request body sent over the wire contains zero raw values', () => {
    assert.strictEqual(requestBody.includes('tomsmith'), false, 'raw username leaked into the real HTTP request body');
    assert.strictEqual(requestBody.includes('Password123'), false, 'raw password leaked into the real HTTP request body');
    assert.ok(requestBody.includes('<<SLOT_1>>') && requestBody.includes('<<SLOT_2>>'), 'expected both slot placeholders in the real request body');
  });

  check('(b) the response has field_mapping populated and action null (per the contract)', () => {
    assert.strictEqual(responseJson.action, null);
    assert.ok(responseJson.field_mapping && typeof responseJson.field_mapping === 'object');
  });

  check('(b) the real LLM correctly maps the slots to username/password', () => {
    const mapping = responseJson.field_mapping;
    const purposes = Object.values(mapping);
    assert.ok(purposes.includes('username'), `expected one slot mapped to "username", got: ${JSON.stringify(mapping)}`);
    assert.ok(purposes.includes('password'), `expected one slot mapped to "password", got: ${JSON.stringify(mapping)}`);
  });

  // (d) Apply the mapping exactly as orchestrator.js's
  // tryServerMediatedFieldMapping() does, then confirm the RETRIED step
  // resolves cleanly through the real fast path with zero raw leakage.
  const mapping = responseJson.field_mapping;
  let patched = slots.slotInstruction;
  for (const slotId of Object.keys(slots.slotValues)) {
    const purpose = mapping[slotId];
    if (!purpose || !CANDIDATE_PURPOSES.includes(purpose)) continue;
    patched = patched.replace(`<<${slotId}>>`, `${purpose} "${slots.slotValues[slotId]}"`);
  }

  check('(d) the patched instruction resolves cleanly via the real fast path on retry', () => {
    const vault = mockVault();
    const finalResult = resolveCredentialTokens(patched, vault);
    assert.strictEqual(finalResult.includes('tomsmith'), false, 'raw username leaked into the final resolved instruction');
    assert.strictEqual(finalResult.includes('Password123'), false, 'raw password leaked into the final resolved instruction');
    assert.strictEqual(vault.tokens.length, 2, 'expected exactly one NAME token and one PASSWORD token to be created');
    assert.ok(vault.tokens.some((t) => t.type === 'NAME' && t.raw === 'tomsmith'));
    assert.ok(vault.tokens.some((t) => t.type === 'PASSWORD' && t.raw === 'Password123'));
  });

  console.log(`\n--- ALL ${passCount} / ${totalCount} FALLBACK END-TO-END CHECKS PASSED ---`);
  console.log(`Single-run fallback round-trip latency: ${latencyMs}ms\n`);

  // --- Item 3: latency sampling over several real, independent runs ---
  console.log(`=== Sampling fallback round-trip latency over ${LATENCY_SAMPLE_COUNT} real runs ===`);
  const latencies = [latencyMs];
  for (let i = 1; i < LATENCY_SAMPLE_COUNT; i++) {
    const { latencyMs: sample, status: sampleStatus } = await runFallbackOnce(crypto.randomUUID());
    if (sampleStatus !== 200) {
      console.warn(`  sample ${i + 1}: non-200 status ${sampleStatus}, excluded from average`);
      continue;
    }
    latencies.push(sample);
    console.log(`  sample ${i + 1}/${LATENCY_SAMPLE_COUNT}: ${sample}ms`);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  console.log(`\nFallback latency over ${latencies.length} real samples: avg=${avg.toFixed(0)}ms, min=${min}ms, max=${max}ms`);
  console.log('(This measures ONLY the fallback round-trip itself — one generate_field_mapping() call, no retry loop of its own.)');

  console.log('\n=== Worst-case compounding analysis (with the existing hallucination-retry loop) ===');
  console.log('server/app/main.py: MAX_RETRIES=3 for the main action-generation loop; each LLM call');
  console.log('(both generate_action and generate_field_mapping) has its own 12s timeout ceiling.');
  console.log('The fallback itself has NO retry loop — one attempt, then falls through to');
  console.log('UNRESOLVED_SENSITIVE_REFERENCE on any failure (no compounding from the fallback\'s own logic).');
  console.log('Worst case for ONE orchestrator step where fallback fires AND the retried step then');
  console.log('needs full hallucination retries: 1 fallback call + up to 3 main-action attempts,');
  console.log(`each up to 12s -> theoretical ceiling ~= 48s. Realistic (measured latency ~${avg.toFixed(0)}ms/call):`);
  console.log(`~= ${avg.toFixed(0)}ms + 3 * ${avg.toFixed(0)}ms ~= ${(avg * 4).toFixed(0)}ms for that worst-realistic case.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
