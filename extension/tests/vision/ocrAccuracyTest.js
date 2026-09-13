/**
 * Phase B.3 — real OCR accuracy + latency measurement.
 *
 * Drives the ACTUAL, unmodified runOcr() from src/vision/ocrPipeline.js
 * (which calls loadOcrWorker() from modelLoader.js, which calls tesseract.js's
 * real createWorker() — real WASM OCR inference, not a mock). Unlike face
 * detection, tesseract.js has a genuine, first-class Node worker
 * implementation (no GPU/WebGL dependency), so this runs directly with no
 * environment-shimming wall.
 *
 * DEVIATION FROM "call runOcr() unmodified", disclosed here: modelLoader.js's
 * loadOcrWorker() hardcodes workerPath/corePath to
 * extension/dist/vendor/tesseract/worker.min.js — the BROWSER build of
 * tesseract.js's worker (expects a classic-Worker global scope with
 * self.addEventListener). Running that specific file under Node's
 * worker_threads throws (`r.g.addEventListener is not a function`) because
 * it's the wrong build for this runtime. Rather than force a mismatched
 * asset path, this harness calls tesseract.js's createWorker('eng') with NO
 * path overrides, letting it use its own correct, first-class Node worker
 * implementation instead — same tesseract.js version, same WASM OCR engine,
 * just the runtime-appropriate entry point. The line-extraction/filtering
 * logic below is copied verbatim from ocrPipeline.js's real runOcr() (it's
 * pure post-processing of the engine's output, not the engine itself) so
 * the actual measured behavior — what counts as a "line", confidence
 * scaling, bounding-box rounding — is identical to production.
 *
 * PII-pattern matching against each fixture's extracted text uses the real,
 * unmodified detectPII() from dev2/pii-patterns.js.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadImage, createCanvas } from 'canvas';
import { createWorker } from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(__dirname, '..', '..');
const distDir = path.join(extensionRoot, 'dist');
const fixturesDir = path.join(extensionRoot, 'tests', 'fixtures', 'ocr');

const { detectPII } = await import('../../../dev2/pii-patterns.js');

// Copied verbatim from src/vision/ocrPipeline.js's real runOcr() — see that
// file for the full explanation of the Tesseract.js v7 output shape.
async function runOcrDirect(worker, imageSource) {
  const { data } = await worker.recognize(imageSource, {}, { blocks: true });
  const rawLines = [];
  for (const block of (data && data.blocks) || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        if (line) rawLines.push(line);
      }
    }
  }
  return rawLines
    .filter((l) => l && l.text && l.text.trim())
    .map((l) => ({
      text: l.text.trim(),
      bounding_box: {
        x: Math.max(0, Math.round(l.bbox.x0)),
        y: Math.max(0, Math.round(l.bbox.y0)),
        w: Math.max(0, Math.round(l.bbox.x1 - l.bbox.x0)),
        h: Math.max(0, Math.round(l.bbox.y1 - l.bbox.y0)),
      },
      confidence: typeof l.confidence === 'number' ? l.confidence / 100 : 0.5,
    }));
}

async function loadAsPngBuffer(imagePath) {
  // tesseract.js's Node image loader expects a real image buffer/path, not
  // a live Canvas object the way an in-browser HTMLCanvasElement works —
  // re-encoding through node-canvas still exercises the same "OCR a
  // rendered canvas" scenario runOcr() is meant for, just via bytes instead
  // of a live element reference.
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return canvas.toBuffer('image/png');
}

async function main() {
  console.log('=== Phase B.3: real OCR accuracy + latency run ===\n');

  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
  const results = [];

  console.log('Loading tesseract.js worker (Node-native path, real WASM OCR engine)...\n');
  const worker = await createWorker('eng', 1);

  for (const entry of manifest) {
    console.log(`--- ${entry.file} ---`);
    const imagePath = path.join(fixturesDir, entry.file);
    const pngBuffer = await loadAsPngBuffer(imagePath);

    const t0 = Date.now();
    const lines = await runOcrDirect(worker, pngBuffer);
    const latencyMs = Date.now() - t0;

    const extractedText = lines.map((l) => l.text).join(' ');
    const detectedPii = detectPII(extractedText);
    const expectedPiiTypes = entry.expected_pii_types || [];
    const detectedPiiTypes = [...new Set(detectedPii.map((m) => m.type))];

    const truePositiveTypes = expectedPiiTypes.filter((t) => detectedPiiTypes.includes(t));
    const falseNegativeTypes = expectedPiiTypes.filter((t) => !detectedPiiTypes.includes(t));
    const falsePositiveTypes = detectedPiiTypes.filter((t) => !expectedPiiTypes.includes(t));

    console.log(`  extracted text (${lines.length} line(s)): ${JSON.stringify(extractedText).slice(0, 200)}`);
    console.log(`  expected ground-truth text: ${JSON.stringify(entry.ground_truth_text).slice(0, 200)}`);
    console.log(`  expected PII types: [${expectedPiiTypes.join(', ')}] — detected PII types: [${detectedPiiTypes.join(', ')}]`);
    console.log(`  latency: ${latencyMs}ms`);

    results.push({
      file: entry.file,
      ground_truth_text: entry.ground_truth_text,
      extracted_text: extractedText,
      raw_ocr_lines: lines,
      expected_pii_types: expectedPiiTypes,
      detected_pii_types: detectedPiiTypes,
      detected_pii_matches: detectedPii,
      true_positive_types: truePositiveTypes,
      false_negative_types: falseNegativeTypes,
      false_positive_types: falsePositiveTypes,
      latency_ms: latencyMs,
    });
  }

  await worker.terminate();

  const totalExpected = results.reduce((s, r) => s + r.expected_pii_types.length, 0);
  const totalTP = results.reduce((s, r) => s + r.true_positive_types.length, 0);
  const totalDetected = results.reduce((s, r) => s + r.detected_pii_types.length, 0);
  const recall = totalExpected > 0 ? totalTP / totalExpected : null;
  const precision = totalDetected > 0 ? totalTP / totalDetected : null;
  const avgLatency = results.reduce((s, r) => s + r.latency_ms, 0) / results.length;

  const summary = {
    generated_at: new Date().toISOString(),
    method: 'Real tesseract.js WASM OCR engine (same version as production, Node-native worker path — ocrPipeline.js\'s own runOcr() hardcodes browser-only worker asset paths that do not run under Node, so this harness calls createWorker() directly instead; the line-extraction/filtering logic that follows is copied verbatim from runOcr(), see this file\'s header comment) -> real detectPII() from dev2/pii-patterns.js against the extracted text. Ground truth text/PII-type expectations were hand-verified against each rendered fixture before running.',
    fixture_count: manifest.length,
    total_expected_pii_types: totalExpected,
    total_detected_pii_types: totalDetected,
    true_positive_pii_types: totalTP,
    recall_pii_type_level: recall,
    precision_pii_type_level: precision,
    average_latency_ms: avgLatency,
    per_fixture: results,
  };

  const outDir = path.join(extensionRoot, '..', 'docs', 'vision-accuracy');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ocr-results.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`recall (PII-type level): ${recall === null ? 'n/a' : (recall * 100).toFixed(1) + '%'} (${totalTP}/${totalExpected})`);
  console.log(`precision (PII-type level): ${precision === null ? 'n/a' : (precision * 100).toFixed(1) + '%'} (${totalTP}/${totalDetected})`);
  console.log(`average latency: ${avgLatency.toFixed(0)}ms`);
  console.log('Results written to docs/vision-accuracy/ocr-results.json');

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
