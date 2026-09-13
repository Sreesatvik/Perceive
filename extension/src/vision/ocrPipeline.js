import { loadOcrWorker } from './modelLoader.js';

/**
 * Runs OCR against a captured canvas/image and returns raw recognized text
 * lines with their bounding boxes. Deliberately does NOT run PII detection
 * here — dev2/redaction-engine.js is the single place that runs detectPII(),
 * exactly as it already does for DOM element text, so PII-pattern logic
 * never has two divergent implementations (Phase 2.1 requirement).
 *
 * @param {HTMLCanvasElement | HTMLImageElement} imageSource
 * @returns {Promise<Array<{ text: string, bounding_box: {x:number,y:number,w:number,h:number}, confidence: number }>>}
 */
export async function runOcr(imageSource) {
  if (!imageSource) return [];

  const markStart = 'perceive:vision:ocr:start';
  const markEnd = 'perceive:vision:ocr:end';
  const measureName = 'perceive:vision:ocr';

  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(markStart);
  }

  let lines = [];
  try {
    const worker = await loadOcrWorker();
    // `blocks: true` is required — Tesseract.js v7 only populates
    // data.text by default; the blocks/paragraphs/lines hierarchy is
    // omitted unless explicitly requested via the output-format argument.
    const { data } = await worker.recognize(imageSource, {}, { blocks: true });

    // Use line-level output, not word-level: a card number ("4111 1111 1111
    // 1111") or email tokenizes into several separate "words", and the PII
    // regex patterns (dev2/pii-patterns.js) need to see the full run of text
    // together to match at all.
    //
    // Tesseract.js v7 nests recognition results as
    // data.blocks[].paragraphs[].lines[] — there is no flat data.lines
    // (verified against the real library in a browser, not assumed from
    // docs; see extension/tests/vision/vision-smoke-test.html).
    const rawLines = [];
    for (const block of (data && data.blocks) || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          if (line) rawLines.push(line);
        }
      }
    }

    lines = rawLines
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
  } catch (err) {
    console.error('[Vision] OCR failed, continuing without this channel:', err);
    lines = [];
  }

  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(markEnd);
    try {
      performance.measure(measureName, markStart, markEnd);
    } catch (_e) { /* noop */ }
  }

  return lines;
}
