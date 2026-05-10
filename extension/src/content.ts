/**
 * content.ts — injected into the Altair tab
 *
 * Responsibilities:
 * - Inject floating push-to-talk button
 * - Capture microphone audio and stream to AssemblyAI for transcription
 * - Receive step instructions from background.ts and highlight the target element
 * - Play TTS audio (base64 data URL) received from background.ts
 * - Detect URL changes and notify background for Tutor Mode
 */

declare const WORKER_URL: string;

import type { ContentMessage, BackgroundMessage } from './types';

// ─── State ────────────────────────────────────────────────────────────────────

let isRecording = false;
let activeMediaStream: MediaStream | null = null;
let activeAudioContext: AudioContext | null = null;
let activeScriptProcessor: ScriptProcessorNode | null = null;
let activeAssemblyWs: WebSocket | null = null;
let accumulatedTranscript = '';
let currentAudio: HTMLAudioElement | null = null;
let urlChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

injectFloatingButton();
patchHistoryForUrlDetection();

// ─── Messages from background ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  switch (message.type) {
    case 'SHOW_STEP':
    case 'FLOW_COMPLETE':
      showSpeechBubble(message.speechText);
      playAudio(message.audioDataUrl);
      if (message.anchor) {
        waitForAnchor(message.anchor, 3000).then((el) => {
          if (el) highlightElement(el);
        });
      }
      break;

    case 'SHOW_MESSAGE':
      showSpeechBubble(message.speechText);
      playAudio(message.audioDataUrl);
      break;

    case 'SHOW_WELCOME':
      showSpeechBubble("Hi! I'm Clicky — your Altair guide. Hold the mic button to ask me anything, or I'll offer tips as you navigate.");
      break;

    case 'CLEAR_OVERLAY':
      clearOverlay();
      break;
  }
});

// ─── Floating PTT button ──────────────────────────────────────────────────────

function injectFloatingButton(): void {
  if (document.getElementById('clicky-trigger')) return;

  const button = document.createElement('button');
  button.id = 'clicky-trigger';
  button.setAttribute('aria-label', 'Ask Clicky — hold to speak');
  button.title = 'Hold to speak to Clicky';
  button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 1a5 5 0 0 1 5 5v6a5 5 0 0 1-10 0V6a5 5 0 0 1 5-5zm-1 17.93V21H9v2h6v-2h-2v-2.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/>
  </svg>`;

  button.addEventListener('mousedown', (e) => { e.preventDefault(); startRecording(); });
  button.addEventListener('mouseup', stopRecording);
  button.addEventListener('mouseleave', stopRecording);
  button.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); }, { passive: false });
  button.addEventListener('touchend', stopRecording);

  document.body.appendChild(button);
}

// ─── Mic capture + AssemblyAI streaming ──────────────────────────────────────

async function startRecording(): Promise<void> {
  if (isRecording) return;
  isRecording = true;
  accumulatedTranscript = '';
  setButtonState('recording');

  try {
    // Get a short-lived AssemblyAI token from the Worker
    const tokenResponse = await fetch(`${WORKER_URL}/transcribe-token`);
    if (!tokenResponse.ok) throw new Error('Failed to get transcription token');
    const { token } = await tokenResponse.json() as { token: string };

    // Open AssemblyAI streaming WebSocket
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${token}&sample_rate=16000&encoding=pcm_s16le`;
    activeAssemblyWs = new WebSocket(wsUrl);

    activeAssemblyWs.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { message_type: string; text?: string };
      if (data.message_type === 'FinalTranscript' && data.text) {
        accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + data.text;
      }
    };

    activeAssemblyWs.onerror = () => stopRecording();

    await waitForWebSocket(activeAssemblyWs, 5000);

    // Capture mic and pipe PCM16 audio to the WebSocket
    activeMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = activeAudioContext.createMediaStreamSource(activeMediaStream);

    // ScriptProcessorNode is deprecated but works in all browsers; AudioWorklet requires
    // loading a separate worker script which complicates extension packaging.
    activeScriptProcessor = activeAudioContext.createScriptProcessor(4096, 1, 1);
    activeScriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!isRecording || activeAssemblyWs?.readyState !== WebSocket.OPEN) return;
      const float32 = event.inputBuffer.getChannelData(0);
      activeAssemblyWs.send(float32ToInt16(float32).buffer);
    };

    source.connect(activeScriptProcessor);
    activeScriptProcessor.connect(activeAudioContext.destination);
  } catch (error) {
    console.error('[clicky] Recording start error:', error);
    stopRecording();
  }
}

function stopRecording(): void {
  if (!isRecording) return;
  isRecording = false;
  setButtonState('idle');

  activeScriptProcessor?.disconnect();
  activeScriptProcessor = null;
  activeMediaStream?.getTracks().forEach((track) => track.stop());
  activeMediaStream = null;
  activeAudioContext?.close().catch(() => undefined);
  activeAudioContext = null;

  if (activeAssemblyWs) {
    activeAssemblyWs.close();
    activeAssemblyWs = null;
  }

  const transcript = accumulatedTranscript.trim();
  if (transcript) {
    const message: BackgroundMessage = { type: 'TRANSCRIPT_READY', text: transcript };
    chrome.runtime.sendMessage(message);
  }
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
  }
  return int16;
}

function waitForWebSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    ws.addEventListener('open', () => resolve(), { once: true });
    setTimeout(() => reject(new Error('WebSocket connection timeout')), timeoutMs);
  });
}

// ─── Element targeting ────────────────────────────────────────────────────────

// Uses MutationObserver so React elements that render conditionally are found
// even if they aren't in the DOM at the moment the step starts.
function waitForAnchor(name: string, timeoutMs: number): Promise<Element | null> {
  const existing = document.querySelector(`[data-clicky-anchor="${name}"]`);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector(`[data-clicky-anchor="${name}"]`);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

function highlightElement(el: Element): void {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('clicky-highlight');
  setTimeout(() => el.classList.remove('clicky-highlight'), 3500);
}

// ─── Speech bubble overlay ────────────────────────────────────────────────────

function showSpeechBubble(text: string): void {
  let bubble = document.getElementById('clicky-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'clicky-bubble';
    document.body.appendChild(bubble);
  }
  bubble.textContent = text;
  bubble.classList.add('clicky-bubble-visible');

  // Auto-dismiss after 10 seconds
  setTimeout(() => bubble?.classList.remove('clicky-bubble-visible'), 10_000);
}

function clearOverlay(): void {
  document.getElementById('clicky-bubble')?.remove();
}

// ─── Audio playback ───────────────────────────────────────────────────────────

function playAudio(dataUrl: string | null): void {
  if (!dataUrl) return;
  currentAudio?.pause();
  currentAudio = new Audio(dataUrl);
  currentAudio.play().catch((error) => console.error('[clicky] Audio play error:', error));
}

// ─── URL change detection (for Tutor Mode) ────────────────────────────────────

function patchHistoryForUrlDetection(): void {
  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    originalPushState(...args);
    scheduleUrlChangedNotification();
  };
  window.addEventListener('popstate', scheduleUrlChangedNotification);
}

function scheduleUrlChangedNotification(): void {
  if (urlChangeDebounceTimer !== null) clearTimeout(urlChangeDebounceTimer);
  // Debounce: wait 800ms after navigation settles before notifying background
  urlChangeDebounceTimer = setTimeout(() => {
    const message: BackgroundMessage = { type: 'URL_CHANGED', url: location.href };
    chrome.runtime.sendMessage(message);
    urlChangeDebounceTimer = null;
  }, 800);
}

// ─── Button state ─────────────────────────────────────────────────────────────

function setButtonState(state: 'idle' | 'recording'): void {
  document.getElementById('clicky-trigger')
    ?.classList.toggle('clicky-trigger-recording', state === 'recording');
}
