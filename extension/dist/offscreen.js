"use strict";
(() => {
  // src/offscreen.ts
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PLAY_AUDIO_OFFSCREEN" && message.dataUrl) {
      const audio = new Audio(message.dataUrl);
      audio.play().catch((error) => console.error("[offscreen] Audio play error:", error));
    }
  });
})();
