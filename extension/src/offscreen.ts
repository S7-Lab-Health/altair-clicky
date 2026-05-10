/**
 * offscreen.ts — fallback audio playback context
 *
 * Used when the content script is not yet injected into a tab (e.g., a flow
 * is triggered from the popup before the user has navigated to Altair).
 * Background sends PLAY_AUDIO_OFFSCREEN with a base64 data URL; this document
 * creates an Audio element and plays it.
 */

chrome.runtime.onMessage.addListener((message: { type: string; dataUrl?: string }) => {
  if (message.type === 'PLAY_AUDIO_OFFSCREEN' && message.dataUrl) {
    const audio = new Audio(message.dataUrl);
    audio.play().catch((error) => console.error('[offscreen] Audio play error:', error));
  }
});
