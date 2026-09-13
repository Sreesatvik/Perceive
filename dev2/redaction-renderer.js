/** Module-level flag controlling Tier 2 redaction (default: true) */
export let REDACT_TIER_2 = true;

/**
 * Sets the module-level flag for Tier 2 redaction.
 * @param {boolean} flag
 */
export function setRedactTier2(flag) {
  REDACT_TIER_2 = Boolean(flag);
}

/**
 * Redacts sensitive regions on an image or canvas by drawing solid black boxes.
 *
 * Two rendering modes, selected per-region via `render` (default 'pill'):
 *   - 'pill': the original fixed-size category boxes (80/160/260 x 24),
 *     centered on the region — correct for DOM form-field text where the
 *     actual value shape is irrelevant to how it should look redacted.
 *   - 'box': a solid fill sized to the region's *actual* bounding box
 *     (Phase 2) — used for vision-detected regions (faces, OCR text) whose
 *     real extent varies far more than a form field's, where a fixed pill
 *     could under-cover a face or a long line of OCR'd text.
 *
 * @param {HTMLCanvasElement | HTMLImageElement} sourceCanvasOrImage
 * @param {Array<{bounding_box: {x: number, y: number, w: number, h: number}, sensitivity_tier: 1|2|3, render?: 'pill'|'box'}>} sensitiveRegions
 * @returns {HTMLCanvasElement} A new canvas containing the redacted image.
 */
export function redactImage(sourceCanvasOrImage, sensitiveRegions = []) {
  if (!sourceCanvasOrImage) {
    throw new Error('Source canvas or image is required.');
  }

  const width = sourceCanvasOrImage.width || sourceCanvasOrImage.naturalWidth || 0;
  const height = sourceCanvasOrImage.height || sourceCanvasOrImage.naturalHeight || 0;

  let outputCanvas;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    outputCanvas = document.createElement('canvas');
    outputCanvas.width = width;
    outputCanvas.height = height;
  } else {
    // Environment fallback (e.g. Node test runner without DOM)
    outputCanvas = {
      width,
      height,
      getContext: () => ({
        drawImage: () => {},
        fillRect: () => {},
        clearRect: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) })
      }),
      toDataURL: () => (typeof sourceCanvasOrImage.toDataURL === 'function' ? sourceCanvasOrImage.toDataURL('image/png') : '')
    };
  }

  const ctx = outputCanvas.getContext('2d');
  if (ctx && typeof ctx.drawImage === 'function') {
    ctx.drawImage(sourceCanvasOrImage, 0, 0, width, height);
  }

  if (Array.isArray(sensitiveRegions)) {
    for (const region of sensitiveRegions) {
      if (!region || !region.bounding_box) continue;

      const tier = region.sensitivity_tier;
      if (tier === 1 || (tier === 2 && REDACT_TIER_2)) {
        const { x, y, w, h } = region.bounding_box;

        if (region.render === 'box') {
          // Exact-extent fill with a small padding margin so anti-aliased
          // detection edges (a face's hairline, an OCR bbox's tight crop)
          // don't leave a sliver of the original content visible.
          const pad = 4;
          if (ctx && typeof ctx.fillRect === 'function') {
            ctx.fillStyle = '#000000';
            ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
          }
        } else {
          let catW = 260;
          let catH = 24;

          if (w <= 80 && h <= 24) {
            catW = 80;
            catH = 24;
          } else if (w <= 160 && h <= 24) {
            catW = 160;
            catH = 24;
          } else {
            catW = 260;
            catH = 24;
          }

          const centerX = x + w / 2;
          const centerY = y + h / 2;
          const drawX = centerX - catW / 2;
          const drawY = centerY - catH / 2;

          if (ctx && typeof ctx.fillRect === 'function') {
            ctx.fillStyle = '#000000';
            ctx.fillRect(drawX, drawY, catW, catH);
          }
        }
      }
    }
  }

  return outputCanvas;
}

/**
 * Converts a canvas element to a PNG base64 string without data URL prefix.
 * @param {HTMLCanvasElement} canvas
 * @returns {string} Base64 encoded PNG data.
 */
export function canvasToBase64(canvas) {
  if (!canvas || typeof canvas.toDataURL !== 'function') {
    return '';
  }
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
