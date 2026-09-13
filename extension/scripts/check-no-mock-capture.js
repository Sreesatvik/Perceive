#!/usr/bin/env node
/**
 * CI-enforceable check for Phase A's "zero mockDev1 involvement in the
 * default build" requirement.
 *
 * mockDev1 has exactly one legitimate home: src/content/orchestrator.js,
 * where it is gated behind either the (hardcoded-false) USE_MOCK_CAPTURE
 * flag or the "no chrome extension runtime at all" plain-webpage test
 * harness fallback in captureOnce(). A reference to it anywhere else in
 * extension/src/ means it has leaked into a live code path outside that
 * single sanctioned, gated location — this script fails the build if that
 * happens, so it's an enforced fact rather than a one-time claim re-checked
 * by hand.
 *
 * Comment-only references (e.g. domIndex.js/visionCache.js's historical
 * documentation of why the worker/dedup logic exists) are intentionally
 * ignored — this checks live code, not prose.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');

const ALLOWED_FILE = path.join(srcDir, 'content', 'orchestrator.js');

function stripComments(code) {
    // Crude but sufficient for a grep-style check: block comments, then
    // line comments. Doesn't need to be a real parser — it only needs to
    // avoid false-failing on the historical prose comments in
    // domIndex.js/visionCache.js. Newlines inside a stripped block comment
    // are preserved (replaced with blanks, not removed) so line numbers in
    // the failure report still line up with the original file.
    return code
        .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
        .replace(/\/\/.*$/gm, '');
}

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(fullPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
}

const violations = [];

for (const file of walk(srcDir)) {
    const code = fs.readFileSync(file, 'utf-8');
    const stripped = stripComments(code);

    if (!stripped.includes('mockDev1')) continue;

    if (path.resolve(file) === path.resolve(ALLOWED_FILE)) {
        continue; // the one sanctioned, gated location
    }

    // Report which lines, for a useful CI failure message.
    const lines = code.split('\n');
    const strippedLines = stripComments(code).split('\n');
    strippedLines.forEach((line, i) => {
        if (line.includes('mockDev1')) {
            violations.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${lines[i].trim()}`);
        }
    });
}

if (violations.length > 0) {
    console.error('[check-no-mock-capture] FAILED — mockDev1 referenced outside its one sanctioned location (src/content/orchestrator.js):');
    for (const v of violations) {
        console.error(`  ${v}`);
    }
    console.error(`\nmockDev1 is a test-only fallback. It must not be used anywhere except the gated block in ${path.relative(process.cwd(), ALLOWED_FILE)}.`);
    process.exit(1);
}

console.log('[check-no-mock-capture] OK — no stray mockDev1 references outside src/content/orchestrator.js');
