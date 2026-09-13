// WARNING: enabling this persists UNREDACTED original screenshots to disk
// via the browser's download folder. Only enable for controlled demo runs,
// never in real usage.
const DEMO_MODE_ENABLED = false; // must default to false — this persists UNREDACTED originals

export async function maybeSaveDemoScreenshot(sessionId, stepNumber, screenshotDataUrl) {
  if (!DEMO_MODE_ENABLED) return;
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
