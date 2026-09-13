/**
 * Phase B.2 — real face-detection accuracy measurement.
 *
 * This drives the ACTUAL, UNMODIFIED extension/dist/faceDetectionWorker.bundle.js
 * (the exact artifact `npm run build` produces and Chrome loads) — not a mock
 * of MediaPipe. It runs the bundle in a Node `vm` sandbox shaped like a
 * classic Worker global scope (self/postMessage/onmessage/importScripts/
 * location), backed by a real local HTTP server standing in for the
 * chrome-extension:// origin that would serve these assets in real Chrome.
 *
 * FINDING (see docs/vision-accuracy/face-detection-results.json for the full
 * evidence trail): getting this far required fixing 8 real, sequential
 * environment gaps in order — Worker plumbing, ImageData, document,
 * importScripts (Node vs Worker environment detection), static-server MIME
 * types, navigator, atob/btoa, and a WebGLRenderingContext presence stub —
 * at which point MediaPipe's actual compiled WASM graph genuinely
 * initialized ("Graph successfully started running", a real log line from
 * MediaPipe's own C++ code, not this harness). It then failed with
 * "Cannot read properties of undefined (reading 'activeTexture')": even
 * BlazeFace's nominal "CPU" delegate requires a real WebGL context for
 * image-texture ingestion, not just the GPU delegate. That requires a
 * native OpenGL binding for Node (e.g. the `gl` / headless-gl package),
 * which itself requires a C++ build toolchain (Visual Studio on Windows)
 * that `npm install gl` confirmed is not present in this environment.
 *
 * Per this phase's own explicit instructions, this is documented rather
 * than worked around by mocking MediaPipe's output. The fixture set and
 * this harness are real, committed, and ready to produce genuine
 * recall/precision numbers on a machine with either a real Chrome browser
 * (the actual production path, via the offscreen document) or a working
 * native GL toolchain for Node.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { loadImage, createCanvas, ImageData } from 'canvas';
import { JSDOM } from 'jsdom';
import { IOU_MATCH_THRESHOLD, scoreDetection } from './faceAccuracyScoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(__dirname, '..', '..');
const distDir = path.join(extensionRoot, 'dist');
const fixturesDir = path.join(extensionRoot, 'tests', 'fixtures', 'faces');

const MIME_TYPES = { '.wasm': 'application/wasm', '.js': 'application/javascript' };

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(rootDir, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Builds one fresh vm sandbox shaped like a classic Worker global scope,
 * with the bundle already evaluated inside it and ready to receive
 * {type:'detect', ...} messages via sandbox.onmessage.
 */
function createWorkerSandbox(bundleSource, distRoot, workerScriptUrl) {
  const dom = new JSDOM('', { url: workerScriptUrl });
  const sandbox = {
    console, URL, URLSearchParams, TextDecoder, TextEncoder, fetch,
    WebAssembly, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ImageData,
    document: dom.window.document,
    performance: dom.window.performance,
    navigator: dom.window.navigator,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    // Presence-only stubs — no real GPU/display exists in this process
    // either way, so the GPU delegate is expected to be unavailable
    // regardless; these exist only to satisfy `instanceof`/type checks in
    // code paths that reference them even when never functionally used.
    WebGLRenderingContext: class WebGLRenderingContext {},
    WebGL2RenderingContext: class WebGL2RenderingContext {},
    // NOTE: `process` is deliberately NOT exposed. Emscripten's own glue
    // branches on `typeof process === 'object'` to pick Node's
    // fs.readFileSync path (which resolves incorrectly against our
    // http:// base URL) vs the Worker's fetch path (which works against
    // our static server) — hiding it here is what selects the fetch path,
    // without touching MediaPipe's code at all.
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { href: workerScriptUrl };

  const context = vm.createContext(sandbox);

  sandbox.importScripts = function importScripts(...urls) {
    for (const url of urls) {
      const u = new URL(url, sandbox.location.href);
      const relPath = decodeURIComponent(u.pathname).replace(/^\//, '');
      const filePath = path.join(distRoot, relPath);
      const code = fs.readFileSync(filePath, 'utf-8');
      vm.runInContext(code, context, { filename: filePath });
    }
  };

  vm.runInContext(bundleSource, context, { filename: 'faceDetectionWorker.bundle.js' });
  return sandbox;
}

async function detectFacesForImage(sandbox, requestId, imagePath) {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('detection timed out after 60s')), 60000);
    const originalPostMessage = sandbox.postMessage;
    sandbox.postMessage = (msg) => {
      if (msg.requestId !== requestId) return;
      if (msg.type === 'log') return;
      clearTimeout(timeout);
      sandbox.postMessage = originalPostMessage;
      if (msg.type === 'result') resolve({ faces: msg.faces, width: img.width, height: img.height });
      else reject(new Error(msg.message || 'worker reported an error'));
    };
    sandbox.onmessage({ data: { type: 'detect', requestId, width: img.width, height: img.height, pixels: imageData.data.buffer } });
  });
}

async function main() {
  console.log('=== Phase B.2: real face-detection accuracy run ===\n');

  const bundlePath = path.join(distDir, 'faceDetectionWorker.bundle.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`${bundlePath} does not exist — run "npm run build" first`);
  }
  const bundleSource = fs.readFileSync(bundlePath, 'utf-8');

  const server = await startStaticServer(distDir);
  const port = server.address().port;
  const workerScriptUrl = `http://127.0.0.1:${port}/faceDetectionWorker.bundle.js`;
  console.log(`Serving extension/dist/ at http://127.0.0.1:${port}/ (for WASM/model asset resolution)\n`);

  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
  const results = [];
  let requestId = 1;

  for (const entry of manifest) {
    // Fresh sandbox per fixture — MediaPipe's WASM module is not
    // guaranteed re-entrant/reusable across independent detect() calls in
    // this harness's simplified protocol, and each fixture is independent.
    const sandbox = createWorkerSandbox(bundleSource, distDir, workerScriptUrl);

    const imagePath = path.join(fixturesDir, entry.file);
    console.log(`--- ${entry.file} (${entry.category}) ---`);
    const t0 = Date.now();
    try {
      const detection = await detectFacesForImage(sandbox, requestId++, imagePath);
      const latencyMs = Date.now() - t0;
      const detectedFaces = detection.faces.map((f) => ({
        box: [f.bounding_box.x / detection.width, f.bounding_box.y / detection.height, f.bounding_box.w / detection.width, f.bounding_box.h / detection.height],
        confidence: f.confidence,
      }));
      const groundTruth = entry.expected_faces.map((gt) => gt.box);
      const scored = scoreDetection(detectedFaces, groundTruth);
      const { matches, truePositives } = scored;
      console.log(`  ground truth: ${groundTruth.length}, detected: ${detectedFaces.length}, matched: ${truePositives}, latency: ${latencyMs}ms`);
      results.push({
        file: entry.file, category: entry.category,
        ground_truth_face_count: groundTruth.length,
        detections: detectedFaces, matches,
        true_positives: truePositives,
        false_negatives: scored.falseNegatives,
        false_positives: scored.falsePositives,
        latency_ms: latencyMs,
      });
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({ file: entry.file, category: entry.category, error: err.message });
    }
  }

  server.close();

  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const totalGT = succeeded.reduce((s, r) => s + (r.ground_truth_face_count || 0), 0);
  const totalTP = succeeded.reduce((s, r) => s + (r.true_positives || 0), 0);
  const totalDet = succeeded.reduce((s, r) => s + (r.detections ? r.detections.length : 0), 0);
  const recall = succeeded.length > 0 && totalGT > 0 ? totalTP / totalGT : null;
  const precision = succeeded.length > 0 && totalDet > 0 ? totalTP / totalDet : null;

  const summary = {
    generated_at: new Date().toISOString(),
    method: 'Attempted: real extension/dist/faceDetectionWorker.bundle.js (unmodified) executed in a Node vm sandbox shaped as a classic Worker scope, backed by a local static server standing in for the chrome-extension:// origin. See this file\'s header comment for the full chain of environment gaps found and fixed, and the one that could not be: MediaPipe\'s WASM graph requires a real WebGL context (even for its "CPU" delegate) for image-texture ingestion, which requires a native GL binding for Node (e.g. `gl`/headless-gl) — confirmed unavailable in this environment (`npm install gl` fails: no C++ build toolchain / Visual Studio present).',
    environment_limitation: failed.length === manifest.length,
    fixtures_attempted: manifest.length,
    fixtures_succeeded: succeeded.length,
    fixtures_failed: failed.length,
    iou_match_threshold: IOU_MATCH_THRESHOLD,
    total_ground_truth_faces_in_succeeded_fixtures: totalGT,
    total_detections: totalDet,
    true_positives: totalTP,
    recall,
    precision,
    per_fixture: results,
  };

  const outDir = path.join(extensionRoot, '..', 'docs', 'vision-accuracy');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'face-detection-results.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`fixtures succeeded: ${succeeded.length}/${manifest.length}`);
  console.log(`recall: ${recall === null ? 'n/a (see environment_limitation)' : (recall * 100).toFixed(1) + '%'}`);
  console.log(`precision: ${precision === null ? 'n/a (see environment_limitation)' : (precision * 100).toFixed(1) + '%'}`);
  console.log('Results written to docs/vision-accuracy/face-detection-results.json');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
