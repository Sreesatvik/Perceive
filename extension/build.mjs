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

// Tesseract.js worker + WASM core (simd-lstm: the fast, recommended default).
// English trained-data is fetched at runtime (~15MB) rather than bundled —
// same tradeoff tesseract.js itself recommends, and it's cached by the
// browser after first use.
copyFile(path.join(nodeModules, 'tesseract.js', 'dist', 'worker.min.js'), path.join(vendorDir, 'tesseract'));
for (const f of ['tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.wasm.js']) {
  const p = path.join(nodeModules, 'tesseract.js-core', f);
  if (fs.existsSync(p)) copyFile(p, path.join(vendorDir, 'tesseract'));
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

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
}
