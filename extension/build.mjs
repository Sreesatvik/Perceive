// Build script for the Perceive extension. No build tooling existed before
// Phase 2 — the extension shipped a stale, hand-built dist/orchestrator.bundle.js
// with no reproducible command behind it. This replaces that with esbuild.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const distDir = path.join(__dirname, 'dist');
const vendorDir = path.join(distDir, 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

// --- Copy runtime assets that must be fetched at a fixed URL at runtime ---
// (WASM/model files aren't bundled inline by esbuild; the vision pipeline
// references these paths via chrome.runtime.getURL()).
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

const nodeModules = path.join(__dirname, 'node_modules');

// MediaPipe's WASM loader + model binaries (face detector .tflite is fetched
// from Google's model store at runtime via a fixed HTTPS URL per Task Vision's
// own API; only the WASM runtime itself needs to ship with the extension).
copyDir(
  path.join(nodeModules, '@mediapipe', 'tasks-vision', 'wasm'),
  path.join(vendorDir, 'mediapipe-wasm')
);

// Tesseract.js worker + WASM core. Copy every core variant (plain/simd/
// relaxedsimd, each with a -lstm pair), not just one — tesseract.js
// auto-detects which WASM feature set the running browser/CPU actually
// supports at runtime and picks the matching file itself; shipping only
// one guessed variant means it 404s (as importScripts NetworkError) on any
// browser that resolves to a different one. English trained-data is
// fetched at runtime (~15MB) rather than bundled — same tradeoff
// tesseract.js itself recommends, and it's cached by the browser after
// first use.
copyFile(path.join(nodeModules, 'tesseract.js', 'dist', 'worker.min.js'), path.join(vendorDir, 'tesseract'));
const tesseractCoreDir = path.join(nodeModules, 'tesseract.js-core');
for (const entry of fs.readdirSync(tesseractCoreDir, { withFileTypes: true })) {
  if (entry.isFile() && /^tesseract-core.*\.(js|wasm)$/.test(entry.name)) {
    copyFile(path.join(tesseractCoreDir, entry.name), path.join(vendorDir, 'tesseract'));
  }
}

console.log('Copied vendor assets to dist/vendor/');

// --- Bundle the content script entry point ---
const buildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'content', 'orchestrator.js')],
  bundle: true,
  outfile: path.join(distDir, 'orchestrator.bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome109',
  sourcemap: true,
  logLevel: 'info',
};

// --- Bundle the face-detection Web Worker as its own, SEPARATE bundle ---
// This must not be inlined into orchestrator.bundle.js: it needs to run in
// its own worker global scope (new Worker(...)) — see faceDetectionWorker.js's
// header comment for why a worker is used at all.
//
// format: 'iife' (a classic script), NOT 'esm' — this matters a lot more
// than it looks. Empirically verified (see extension/tests/vision/raw-worker-test*.html):
// MediaPipe's internal WASM glue loader ($h in the minified vision_bundle)
// does `if (typeof importScripts !== 'function') { <inject a <script> tag
// via document, which doesn't exist in a worker> } else { try { importScripts(url) }
// catch (TypeError) { await import(url) } }`. A `type: 'module'` WORKER
// throws when `importScripts` is called (it's disallowed in module workers),
// so it falls into the `import(url)` branch — and that dynamic import of a
// non-ESM classic glue script does NOT end up setting `self.ModuleFactory`,
// reproducing "ModuleFactory not set" on BOTH the GPU and CPU delegate
// attempts, in ANY module worker (verified with a plain page's own worker,
// nothing to do with extension isolated worlds — that was the original,
// incorrect hypothesis). A CLASSIC worker's `importScripts` works exactly
// as MediaPipe's glue loader expects and sets self.ModuleFactory correctly,
// confirmed empirically with a real GPU-delegate detection succeeding.
// esbuild bundles our ESM `import` source into a plain IIFE at build time,
// so the worker file itself needs no runtime ESM support — only the
// `new Worker(url)` call (no `{ type: 'module' }`) matters at runtime.
const workerBuildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'vision', 'faceDetectionWorker.js')],
  bundle: true,
  outfile: path.join(distDir, 'faceDetectionWorker.bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome109',
  sourcemap: true,
  logLevel: 'info',
};

// --- Bundle the offscreen-document script as its own bundle too ---
// Loaded via a plain <script src="..."> tag from src/background/offscreen.html
// (a real window/DOM context, not a worker or service worker) — see
// offscreenFaceDetection.js's header comment for why this document exists:
// Chrome cannot spawn a Worker from within a Service Worker at all, so the
// background service worker (transport.js) relays DETECT_FACES requests
// here instead of owning the face-detection worker itself.
const offscreenBuildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'background', 'offscreenFaceDetection.js')],
  bundle: true,
  outfile: path.join(distDir, 'offscreenFaceDetection.bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome109',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  const workerCtx = await esbuild.context(workerBuildOptions);
  const offscreenCtx = await esbuild.context(offscreenBuildOptions);
  await Promise.all([ctx.watch(), workerCtx.watch(), offscreenCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  await esbuild.build(workerBuildOptions);
  await esbuild.build(offscreenBuildOptions);
}
