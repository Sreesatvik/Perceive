import { IOU_MATCH_THRESHOLD, scoreDetection } from './faceAccuracyScoring.js';

const status = document.getElementById('status');
const output = document.getElementById('output');
const presetSelect = document.getElementById('preset');
const runButton = document.getElementById('run');
const customConfigInput = document.getElementById('customConfig');
const runCustomButton = document.getElementById('runCustom');
const copyAllButton = document.getElementById('copyAll');
const allRuns = []; // every completed run this session, in order — Phase B.5's full picture

const extensionRuntime = globalThis.chrome && globalThis.chrome.runtime;
if (!extensionRuntime || typeof extensionRuntime.getURL !== 'function' || typeof extensionRuntime.sendMessage !== 'function') {
  const message = 'This harness must be opened as chrome-extension://<extension-id>/tests/vision/faceAccuracyTest.html. Load extension/ as an unpacked extension, then open the URL from chrome://extensions; do not open the HTML file directly.';
  status.textContent = message;
  runButton.disabled = true;
  runCustomButton.disabled = true;
  throw new Error(message);
}

const fixtureRoot = extensionRuntime.getURL('tests/fixtures/faces/');

// Phase B.5 — named presets matching the task's Steps 0/1/2/4/5. Step 6
// (combined) is intentionally NOT a preset here: its exact composition
// depends on which of 1/4/5 actually moved the needle, so use the "custom
// config" box below once those results are in, rather than guessing its
// composition in advance.
const PRESETS = {
  'step0_baseline (current shipped default, expanded 25-fixture set)': {},
  'step1_full_range (model swap only)': { model: 'full_range' },
  'step2_union_short_full (both models unioned + deduped @0.5, separate 3rd data point)': { unionWithModel: 'full_range', dedupIouThreshold: 0.5 },
  'step4_suppression_adjusted (minSuppressionThreshold 0.3 -> 0.5 — substitute for the non-existent maxResults option, see report)': { minSuppressionThreshold: 0.5 },
  'step5_dedup_only (IoU 0.5 post-hoc dedup, baseline model/settings otherwise)': { dedupIouThreshold: 0.5 },
};

for (const label of Object.keys(PRESETS)) {
  const option = document.createElement('option');
  option.value = label;
  option.textContent = label;
  presetSelect.appendChild(option);
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

function requestDetection(width, height, pixels, config) {
  return new Promise((resolve, reject) => {
    extensionRuntime.sendMessage({ type: 'DETECT_FACES', width, height, pixels: encodePixelBuffer(pixels), config }, (response) => {
      if (extensionRuntime.lastError) {
        reject(new Error(extensionRuntime.lastError.message));
      } else if (!response || !response.success) {
        reject(new Error((response && response.error) || 'DETECT_FACES failed'));
      } else {
        if (!response.config_actually_applied) {
          reject(new Error('Worker did not return config_actually_applied; reload the rebuilt extension before trusting metrics'));
          return;
        }
        resolve({ faces: response.faces || [], latency_ms: response.latency_ms, config_actually_applied: response.config_actually_applied });
      }
    });
  });
}

function encodePixelBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function scoreCategory(results) {
  const groundTruth = results.reduce((sum, result) => sum + (result.ground_truth_face_count || 0), 0);
  const detections = results.reduce((sum, result) => sum + (result.detections ? result.detections.length : 0), 0);
  const truePositives = results.reduce((sum, result) => sum + (result.true_positives || 0), 0);
  return {
    fixtures: results.length,
    ground_truth_faces: groundTruth,
    detections,
    true_positives: truePositives,
    recall: groundTruth > 0 ? truePositives / groundTruth : null,
    precision: detections > 0 ? truePositives / detections : null,
  };
}

function renderTable(summary) {
  const categories = Object.entries(summary.per_category);
  document.querySelector('#results tbody').innerHTML = categories.map(([category, value]) => `
    <tr><td>${category}</td><td>${value.ground_truth_faces}</td><td>${value.detections}</td><td>${value.true_positives}</td><td>${percent(value.recall)}</td><td>${percent(value.precision)}</td></tr>
  `).join('');
  document.getElementById('results').hidden = false;
}

function renderAllRuns() {
  output.value = JSON.stringify({ results: allRuns }, null, 2);
  copyAllButton.disabled = allRuns.length === 0;
}

function detectionSignature(summary) {
  return JSON.stringify(summary.per_fixture.map((fixture) => ({
    file: fixture.file,
    error: fixture.error || null,
    detections: (fixture.detections || []).map((detection) => ({
      box: detection.box,
      confidence: detection.confidence,
    })),
  })));
}

function updateCrossRunSanity() {
  const baseline = allRuns.find((run) => run.label.startsWith('step0_baseline'));
  if (!baseline) return;
  const checks = {};
  for (const step of ['step1_full_range', 'step5_dedup_only']) {
    const candidate = allRuns.find((run) => run.label.startsWith(step));
    if (!candidate) continue;
    const identical = detectionSignature(baseline) === detectionSignature(candidate);
    checks[`step0_vs_${step}`] = {
      compared: true,
      detections_identical: identical,
      result: identical ? 'BLOCKED_IDENTICAL_DETECTIONS' : 'PASS_DIFFERENT_DETECTIONS',
    };
    if (identical) {
      console.error(`[Accuracy Harness] ${step} is bit-identical to step0; do not report these metrics as a genuine configuration experiment.`);
    }
  }
  const blocked = Object.values(checks).some((check) => check.detections_identical);
  const latest = allRuns[allRuns.length - 1];
  latest.cross_run_sanity = checks;
  latest.metrics_valid_for_reporting = !blocked;
  renderAllRuns();
  if (blocked) {
    status.textContent += ' BLOCKED: Step 0 and a configured run have identical detections; inspect worker proof/bundle before reporting metrics.';
  }
}

async function runOneConfig(label, config) {
  runButton.disabled = true;
  runCustomButton.disabled = true;
  const manifest = await fetch(`${fixtureRoot}manifest.json`).then((response) => {
    if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
    return response.json();
  });
  const results = [];
  status.textContent = `[${label}] Running ${manifest.length} fixtures...`;

  for (const entry of manifest) {
    const started = performance.now();
    try {
      const image = await loadImage(`${fixtureRoot}${entry.file}`);
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const { faces, latency_ms, config_actually_applied } = await requestDetection(canvas.width, canvas.height, imageData.data.buffer, config);
      const detections = faces.map((face) => ({
        box: [
          face.bounding_box.x / canvas.width,
          face.bounding_box.y / canvas.height,
          face.bounding_box.w / canvas.width,
          face.bounding_box.h / canvas.height,
        ],
        confidence: face.confidence,
      }));
      const groundTruth = entry.expected_faces.map((face) => face.box);
      const scored = scoreDetection(detections, groundTruth);
      results.push({
        file: entry.file,
        category: entry.category,
        ground_truth_face_count: groundTruth.length,
        detections,
        matches: scored.matches,
        true_positives: scored.truePositives,
        false_negatives: scored.falseNegatives,
        false_positives: scored.falsePositives,
        latency_ms: Math.round(performance.now() - started),
        worker_latency_ms: latency_ms,
        config_actually_applied,
      });
      status.textContent = `[${label}] Completed ${results.length}/${manifest.length}: ${entry.file}`;
      console.log(`[${label}] ${entry.file}: ground truth ${groundTruth.length}, detected ${detections.length}, matched ${scored.truePositives}, latency ${Math.round(performance.now() - started)}ms`, latency_ms ? `(worker: ${JSON.stringify(latency_ms)})` : '');
    } catch (error) {
      results.push({ file: entry.file, category: entry.category, error: error.message });
      console.error(`[${label}] ${entry.file}: ERROR`, error);
    }
  }

  const succeeded = results.filter((result) => !result.error);
  const failed = results.filter((result) => result.error);
  const totalGroundTruth = succeeded.reduce((sum, result) => sum + result.ground_truth_face_count, 0);
  const totalDetections = succeeded.reduce((sum, result) => sum + result.detections.length, 0);
  const totalTruePositives = succeeded.reduce((sum, result) => sum + result.true_positives, 0);
  const perCategory = {};
  for (const result of succeeded) (perCategory[result.category] ||= []).push(result);
  for (const category of Object.keys(perCategory)) perCategory[category] = scoreCategory(perCategory[category]);

  const avgLatency = succeeded.length > 0 ? succeeded.reduce((sum, r) => sum + r.latency_ms, 0) / succeeded.length : null;

  const summary = {
    label,
    config,
    config_actually_applied: results.find((result) => !result.error)?.config_actually_applied || null,
    generated_at: new Date().toISOString(),
    method: 'Real Chrome extension page using DETECT_FACES -> transport.js detectFacesInBackground() -> chrome.offscreen document -> faceDetectionWorker.bundle.js.',
    environment: 'Chrome extension page (chrome-extension:// origin)',
    fixtures_attempted: manifest.length,
    fixtures_succeeded: succeeded.length,
    fixtures_failed: failed.length,
    iou_match_threshold: IOU_MATCH_THRESHOLD,
    total_ground_truth_faces: totalGroundTruth,
    total_detections: totalDetections,
    true_positives: totalTruePositives,
    recall: succeeded.length > 0 && totalGroundTruth > 0 ? totalTruePositives / totalGroundTruth : null,
    precision: succeeded.length > 0 && totalDetections > 0 ? totalTruePositives / totalDetections : null,
    average_latency_ms: avgLatency,
    per_category: perCategory,
    per_fixture: results,
  };
  allRuns.push(summary);
  updateCrossRunSanity();
  renderTable(summary);
  renderAllRuns();
  status.textContent = `[${label}] Done: ${succeeded.length}/${manifest.length} fixtures. Recall ${percent(summary.recall)}, precision ${percent(summary.precision)}, avg latency ${avgLatency ? avgLatency.toFixed(0) + 'ms' : 'n/a'}.`;
  console.log(`=== REAL CHROME FACE ACCURACY SUMMARY: ${label} ===`);
  console.log(JSON.stringify(summary, null, 2));
  runButton.disabled = false;
  runCustomButton.disabled = false;
}

runButton.addEventListener('click', () => {
  const label = presetSelect.value;
  runOneConfig(label, PRESETS[label]).catch((error) => {
    status.textContent = `Fatal error: ${error.message}`;
    console.error('FATAL:', error);
    runButton.disabled = false;
    runCustomButton.disabled = false;
  });
});

runCustomButton.addEventListener('click', () => {
  let config;
  try {
    config = JSON.parse(customConfigInput.value || '{}');
  } catch (e) {
    status.textContent = `Custom config is not valid JSON: ${e.message}`;
    return;
  }
  const label = `step6_combined (custom: ${JSON.stringify(config)})`;
  runOneConfig(label, config).catch((error) => {
    status.textContent = `Fatal error: ${error.message}`;
    console.error('FATAL:', error);
    runButton.disabled = false;
    runCustomButton.disabled = false;
  });
});

copyAllButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify({ results: allRuns }, null, 2));
  status.textContent += ' All-runs JSON copied to clipboard.';
});

status.textContent = 'Select a preset (in order: step0, step1, step2, step4, step5) and click "Run preset". After seeing 1/4/5\'s results, use the custom-config box for Step 6.';
