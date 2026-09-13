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

function renderStep(data) {
  emptyState.style.display = 'none';
  stepCount++;

  const card = document.createElement('div');
  card.className = 'step-card';

  const action = data.action || {};
  const riskClass = action.risk_tier === 'risky' ? 'risk-risky' : 'risk-safe';
  const payloadJson = JSON.stringify(
    { session_id: data.sessionId, step_number: data.stepNumber, dom_summary: data.domSummary, redacted_regions: data.redactedRegions, detection_confidence_notes: data.confidenceNotes },
    null, 2
  );
  const payloadId = `payload-${stepCount}`;

  card.innerHTML = `
    <div class="step-header">
      <span class="step-num">Step ${escapeHtml(data.stepNumber)} — session ${escapeHtml((data.sessionId || '').slice(0, 8))}</span>
      <span>${new Date(data.timestamp).toLocaleTimeString()}</span>
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
      Action: <code>${escapeHtml(action.type)}</code>
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

const hasChromeRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;
if (hasChromeRuntime) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'AUDIT_STEP_UPDATE') {
      renderStep(message.data);
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

// Exposed for the standalone visual-verification harness
// (extension/tests/dashboard/dashboard-visual-test.html), which runs this
// page outside the extension runtime and feeds it mock step data directly.
window.__renderStepForTest = renderStep;
