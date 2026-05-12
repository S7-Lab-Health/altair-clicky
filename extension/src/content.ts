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

// Only inject UI if the user has an active Altair session.
// Runs in the page context so the browser's session cookies are sent automatically.
(async () => {
  try {
    const resp = await fetch(`${window.location.origin}/api/users/me`, { credentials: 'include' });
    if (!resp.ok) return;
  } catch {
    return;
  }
  // Hard page reload — clear any persisted flow so the user starts fresh
  try { chrome.runtime.sendMessage({ type: 'CLOSE_FLOW' } satisfies BackgroundMessage); } catch { /* SW not ready */ }
  injectFloatingButton();
  injectTextPanel();
  patchHistoryForUrlDetection();
})();

// ─── Messages from background ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  switch (message.type) {
    case 'SHOW_STEP':
      appendStepMessage(message.speechText, message.hasNext);
      playAudio(message.audioDataUrl);
      if (message.anchor) {
        waitForAnchor(message.anchor, 3000).then((el) => {
          if (el) {
            highlightElement(el);
            if (message.autoClick) {
              const urlAtClick = window.location.href;
              setTimeout(() => {
                (el as HTMLElement).click();
                // If the click didn't navigate (e.g. opened a dialog), auto-advance after 1.5s
                setTimeout(() => {
                  if (window.location.href === urlAtClick) {
                    document.querySelectorAll('.clicky-next-btn').forEach((btn) => btn.remove());
                    try {
                      chrome.runtime.sendMessage({ type: 'STEP_COMPLETE' } satisfies BackgroundMessage);
                    } catch { /* ignore */ }
                  }
                  // If URL changed, handleUrlChanged in background advances the flow
                }, 1500);
              }, 500);
            }
          }
        });
      }
      break;

    case 'FLOW_DONE':
      appendStepMessage(message.speechText, false);
      playAudio(message.audioDataUrl);
      if (message.anchor) {
        waitForAnchor(message.anchor, 3000).then((el) => {
          if (el) {
            highlightElement(el);
            if (message.autoClick) setTimeout(() => (el as HTMLElement).click(), 500);
          }
        });
      }
      break;

    case 'SHOW_MESSAGE':
      appendStepMessage(message.speechText, false, false);
      playAudio(message.audioDataUrl);
      break;

    case 'PLAY_AUDIO':
      playAudio(message.audioDataUrl);
      break;

    case 'SHOW_WELCOME':
      appendStepMessage("Hi! I'm Clicky — your Altair guide. Click the button to ask me anything.", false);
      break;

    case 'CLEAR_OVERLAY':
      hideClickyPanel();
      break;
  }
});

// ─── Floating button (chat toggle) ───────────────────────────────────────────

function injectFloatingButton(): void {
  if (document.getElementById('clicky-trigger')) return;

  const button = document.createElement('button');
  button.id = 'clicky-trigger';
  button.setAttribute('aria-label', 'Ask Clicky');
  button.title = 'Ask Clicky';
  // Chat bubble icon
  button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
  </svg>`;

  button.addEventListener('click', toggleTextPanel);

  document.body.appendChild(button);
}

// ─── Text input panel ─────────────────────────────────────────────────────────

function injectTextPanel(): void {
  if (document.getElementById('clicky-text-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'clicky-text-panel';
  panel.setAttribute('aria-label', 'Ask Clicky');

  const input = document.createElement('input');
  input.id = 'clicky-text-input';
  input.type = 'text';
  input.placeholder = 'Ask Clicky anything…';
  input.setAttribute('aria-label', 'Ask Clicky');

  const sendBtn = document.createElement('button');
  sendBtn.id = 'clicky-send-btn';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
  </svg>`;

  const submitText = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    hideTextPanel();
    try {
      const message: BackgroundMessage = { type: 'TRANSCRIPT_READY', text };
      chrome.runtime.sendMessage(message);
    } catch {
      appendStepMessage('Extension reloaded — please refresh this page to use Clicky.', false);
    }
  };

  sendBtn.addEventListener('click', submitText);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });

  panel.appendChild(input);
  panel.appendChild(sendBtn);
  document.body.appendChild(panel);
}

function toggleTextPanel(): void {
  const panel = document.getElementById('clicky-text-panel');
  if (!panel) return;
  const isVisible = panel.classList.contains('clicky-panel-visible');
  if (isVisible) {
    hideTextPanel();
  } else {
    panel.classList.add('clicky-panel-visible');
    setTimeout(() => document.getElementById('clicky-text-input')?.focus(), 50);
  }
}

function hideTextPanel(): void {
  document.getElementById('clicky-text-panel')?.classList.remove('clicky-panel-visible');
}

// ─── Mic capture + AssemblyAI streaming ──────────────────────────────────────

async function startRecording(): Promise<void> {
  if (isRecording) return;
  isRecording = true;
  accumulatedTranscript = '';
  setButtonState('recording');

  try {
    // Get a short-lived AssemblyAI token via background (background adds auth header)
    const tokenData = await chrome.runtime.sendMessage(
      { type: 'GET_TRANSCRIBE_TOKEN' } satisfies BackgroundMessage
    ) as { token: string } | null;
    if (!tokenData) throw new Error('Failed to get transcription token — please sign in');
    const { token } = tokenData;

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
  const rect = el.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'clicky-highlight';
  ring.style.cssText = `position:fixed;top:${rect.top - 4}px;left:${rect.left - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px;pointer-events:none;z-index:2147483646;border-radius:8px;`;
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 8000);
}

// ─── Chat panel ───────────────────────────────────────────────────────────────

function ensureClickyPanel(): HTMLElement {
  let panel = document.getElementById('clicky-panel');
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'clicky-panel';

  const header = document.createElement('div');
  header.id = 'clicky-panel-header';

  const label = document.createElement('span');
  label.textContent = 'Clicky';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'clicky-panel-close';
  closeBtn.setAttribute('aria-label', 'Close Clicky');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', hideClickyPanel);

  header.appendChild(label);
  header.appendChild(closeBtn);

  const messages = document.createElement('div');
  messages.id = 'clicky-panel-messages';

  panel.appendChild(header);
  panel.appendChild(messages);
  document.body.appendChild(panel);

  return panel;
}

function appendStepMessage(text: string, hasNext: boolean, isStep = true): void {
  const panel = ensureClickyPanel();
  const messages = document.getElementById('clicky-panel-messages')!;

  // Only remove the Next button when showing a new step — not for inline Q&A replies
  if (isStep) messages.querySelectorAll('.clicky-next-btn').forEach((btn) => btn.remove());

  const msgEl = document.createElement('div');
  msgEl.className = 'clicky-message';

  const p = document.createElement('p');
  p.className = 'clicky-message-text';
  p.textContent = text;
  msgEl.appendChild(p);

  if (hasNext) {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'clicky-next-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.addEventListener('click', () => {
      nextBtn.remove();
      try {
        const msg: BackgroundMessage = { type: 'STEP_COMPLETE' };
        chrome.runtime.sendMessage(msg);
      } catch {
        appendStepMessage('Extension reloaded — please refresh this page to continue.', false);
      }
    });
    msgEl.appendChild(nextBtn);
  }

  messages.appendChild(msgEl);
  panel.classList.add('clicky-panel-chat-visible');
  messages.scrollTop = messages.scrollHeight;
}

function hideClickyPanel(): void {
  const panel = document.getElementById('clicky-panel');
  if (!panel) return;
  panel.classList.remove('clicky-panel-chat-visible');
  setTimeout(() => {
    const messages = document.getElementById('clicky-panel-messages');
    if (messages) messages.innerHTML = '';
    try {
      const msg: BackgroundMessage = { type: 'CLOSE_FLOW' };
      chrome.runtime.sendMessage(msg);
    } catch { /* ignore */ }
  }, 220);
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
