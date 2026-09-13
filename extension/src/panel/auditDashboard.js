// Phase 4.1/4.2 — live audit/redaction dashboard.
// Listens for AUDIT_STEP_UPDATE messages broadcast by orchestrator.js after
// every step, and renders: original vs redacted screenshot side by side,
// every detected sensitive region with its detection_source and Phase 3
// reason, the exact structural payload actually sent to the server, and the
// LLM's returned action with its server-assigned risk_tier — plus the Phase
// 2.7 latency marks for that step.

const container = document.getElementById('steps-container');
const emptyState = document.getElementById('empty-state');
let stepCount = 0;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function sourceBadge(source) {
  const cls = 'source-' + (source || 'dom_heuristic');
  const label = { dom_heuristic: 'DOM', vision_model: 'vision', ocr_regex: 'OCR' }[source] || source || 'unknown';
  return `<span class="source-badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderRegionsTable(regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return '<p style="font-size:12px;color:#777;">No sensitive regions detected this step.</p>';
  }
  const rows = regions.map(r => `
    <tr>
      <td>${escapeHtml(r.element_id)}</td>
      <td>${escapeHtml(r.sensitivity_type)}</td>
      <td>${sourceBadge(r.detection_source || 'dom_heuristic')}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${escapeHtml(r.semantic_token) || '<span style="color:#666">—</span>'}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>Element</th><th>Type</th><th>Source</th><th>Reason</th><th>Token</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderMetrics(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return '';
  const chips = metrics.map(m => {
    const shortName = m.name.replace('perceive:step:', '');
    return `<span class="metric-chip">${escapeHtml(shortName)}: <b>${m.durationMs}ms</b></span>`;
  }).join('');
  return `<div class="metrics-row">${chips}</div>`;
}

function toDataUrl(base64) {
  if (!base64) return '';
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function executedBadge(executed) {
  if (executed === true) return '<span class="status-chip ok">Executed: yes</span>';
  if (executed === false) return '<span class="status-chip bad">Executed: NO (failed)</span>';
  return '<span class="status-chip exec-unknown">Executed: pending…</span>';
}

function visionStatusChips(visionStatus) {
  if (!visionStatus) return '';
  const ocrClass = visionStatus.ocr && visionStatus.ocr.includes('unavailable') ? 'bad' : 'ok';
  const faceClass = visionStatus.faceDetection && visionStatus.faceDetection.includes('unavailable')
    ? 'bad'
    : 'warn'; // "active but not yet validated" is deliberately never shown as a clean "ok" green
  return `
    <span class="status-chip ${ocrClass}">${escapeHtml(visionStatus.ocr)}</span>
    <span class="status-chip ${faceClass}">${escapeHtml(visionStatus.faceDetection)}</span>
  `;
}

function renderStep(data) {
  emptyState.style.display = 'none';
  stepCount++;

  const card = document.createElement('div');
  card.className = 'step-card';
  card.dataset.sessionId = data.sessionId || '';
  card.dataset.stepNumber = String(data.stepNumber);

  const action = data.action || {};
  const riskClass = action.risk_tier === 'risky' ? 'risk-risky' : 'risk-safe';
  const payloadJson = JSON.stringify(
    { session_id: data.sessionId, step_number: data.stepNumber, dom_summary: data.domSummary, redacted_regions: data.redactedRegions, detection_confidence_notes: data.confidenceNotes },
    null, 2
  );
  const payloadId = `payload-${stepCount}`;
  const piiClass = (data.rawPiiStatus || '').toUpperCase().startsWith('BLOCKED —') ? 'warn' : 'ok';

  card.innerHTML = `
    <div class="step-header">
      <span class="step-num">Step ${escapeHtml(data.stepNumber)} — session ${escapeHtml((data.sessionId || '').slice(0, 8))}</span>
      <span>${new Date(data.timestamp).toLocaleTimeString()}</span>
    </div>
    <div class="status-row">
      <span class="status-chip ok">DOM findings: <b>${escapeHtml(data.domFindings)}</b></span>
      <span class="status-chip ok">Vision findings: <b>${escapeHtml(data.visionFindings)}</b></span>
      ${visionStatusChips(data.visionStatus)}
      <span class="status-chip ok">Elements redacted: <b>${escapeHtml(data.elementsRedacted)}</b></span>
      <span class="status-chip ${piiClass}">Raw PII transmitted: ${escapeHtml(data.rawPiiStatus || 'unknown')}</span>
      <span class="exec-badge">${executedBadge(data.executed)}</span>
    </div>
    <div class="images-row">
      <div class="image-col">
        <div class="label">Original (never leaves the browser)</div>
        ${data.originalImageBase64 ? `<img src="${toDataUrl(data.originalImageBase64)}" alt="Original screenshot">` : '<div style="color:#666;font-size:12px;">no image captured</div>'}
      </div>
      <div class="image-col">
        <div class="label">Redacted (this is what leaves the browser)</div>
        ${data.redactedImageBase64 ? `<img src="${toDataUrl(data.redactedImageBase64)}" alt="Redacted screenshot">` : '<div style="color:#666;font-size:12px;">no image captured</div>'}
      </div>
    </div>
    <div class="action-line">
      Proposed action: <code>${escapeHtml(action.type)}</code>
      ${action.target_element_id ? ` → <code>${escapeHtml(action.target_element_id)}</code>` : ''}
      &nbsp; <span class="risk-badge ${riskClass}">${escapeHtml(action.risk_tier || 'unknown')}</span>
      ${action.reasoning_short ? `<div style="color:#888;margin-top:4px;">"${escapeHtml(action.reasoning_short)}"</div>` : ''}
    </div>
    ${renderRegionsTable(data.redactedRegions)}
    ${renderMetrics(data.metrics)}
    <span class="payload-toggle" data-target="${payloadId}">▸ show exact structural payload sent to the server</span>
    <pre class="payload" id="${payloadId}">${escapeHtml(payloadJson)}</pre>
  `;

  container.prepend(card);

  card.querySelector('.payload-toggle').addEventListener('click', (e) => {
    const pre = document.getElementById(payloadId);
    const isOpen = pre.style.display === 'block';
    pre.style.display = isOpen ? 'none' : 'block';
    e.target.textContent = (isOpen ? '▸ show' : '▾ hide') + ' exact structural payload sent to the server';
  });
}

/**
 * Phase D.3: patches the "Executed: …" badge on an already-rendered step
 * card in place, once orchestrator.js's AUDIT_STEP_EXECUTION_RESULT
 * arrives (execution happens strictly after the initial AUDIT_STEP_UPDATE
 * broadcast — see orchestrator.js's broadcastAuditExecutionResult).
 */
function patchExecutionResult({ sessionId, stepNumber, executed }) {
  const selector = `.step-card[data-session-id="${CSS.escape(sessionId || '')}"][data-step-number="${CSS.escape(String(stepNumber))}"]`;
  const card = container.querySelector(selector);
  if (!card) return; // step card scrolled off/cleared — non-fatal
  const badgeContainer = card.querySelector('.exec-badge');
  if (badgeContainer) badgeContainer.innerHTML = executedBadge(executed);
}

const hasChromeRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;
if (hasChromeRuntime) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'AUDIT_STEP_UPDATE') {
      renderStep(message.data);
    } else if (message && message.type === 'AUDIT_STEP_EXECUTION_RESULT') {
      patchExecutionResult(message.data);
    }
  });
}

document.getElementById('clear-btn').addEventListener('click', () => {
  container.innerHTML = '';
  stepCount = 0;
  emptyState.style.display = 'block';
});

document.getElementById('redteam-btn').addEventListener('click', () => {
  if (hasChromeRuntime) {
    chrome.tabs.create({ url: chrome.runtime.getURL('tests/redteam/redteam-page.html') });
  } else {
    window.open('../../tests/redteam/redteam-page.html', '_blank');
  }
});

document.getElementById('audit-log-btn').addEventListener('click', () => {
  if (hasChromeRuntime) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/auditLogViewer.html') });
  } else {
    window.open('auditLogViewer.html', '_blank');
  }
});

document.getElementById('before-after-btn').addEventListener('click', () => {
  if (hasChromeRuntime) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/beforeAfterViewer.html') });
  } else {
    window.open('beforeAfterViewer.html', '_blank');
  }
});

// Exposed for the standalone visual-verification harness
// (extension/tests/dashboard/dashboard-visual-test.html), which runs this
// page outside the extension runtime and feeds it mock step data directly.
window.__renderStepForTest = renderStep;
