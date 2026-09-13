// WARNING: enabling DEMO_MODE_ENABLED (extension/src/shared/constants.js)
// persists UNREDACTED original screenshots to disk via the browser's
// download folder. Only enable for controlled demo runs, never in real
// usage. The flag lives in constants.js (not here) so its default is easy
// to audit in one place alongside the rest of the extension's constants.
import { DEMO_MODE_ENABLED } from '../shared/constants.js';

let _warnedThisSession = false;

export async function maybeSaveDemoScreenshot(sessionId, stepNumber, screenshotDataUrl) {
  if (!DEMO_MODE_ENABLED) return;
  // Loud, hard-to-miss visible indicator: fires once per service-worker
  // lifetime (not once per step) so a demo run doesn't spam the console,
  // but so nobody can miss that this is on if they check DevTools at all.
  if (!_warnedThisSession) {
    console.warn(
      '%c[Perceive] DEMO MODE IS ON — saving UNREDACTED original screenshots to disk (perceive-demo/). ' +
      'This is instrumentation for a deliberate demo run, not a normal feature. Turn DEMO_MODE_ENABLED ' +
      'back off in extension/src/shared/constants.js when the demo is done.',
      'background: #b00; color: #fff; font-weight: bold; padding: 2px 6px;'
    );
    _warnedThisSession = true;
  }
  if (typeof chrome === 'undefined' || !chrome.downloads) return;
  try {
    await chrome.downloads.download({
      url: screenshotDataUrl,
      filename: `perceive-demo/${sessionId}/${stepNumber}_original.png`,
      saveAs: false,
    });
  } catch (e) {
    console.error('[DemoCapture] Failed to save demo screenshot:', e);
  }
}
