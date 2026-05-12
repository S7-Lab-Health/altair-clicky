/**
 * background.ts — MV3 service worker
 *
 * Responsibilities:
 * - Validate the user's Altair session before every Worker call (via /api/users/me)
 * - Receive transcript from content.ts → call Worker /chat → send step back
 * - Manage active flow state in chrome.storage.local (never in-memory — SW restarts after 30s idle)
 * - Fetch TTS audio from Worker → encode as base64 data URL → send to content.ts for playback
 * - Proxy AssemblyAI transcription tokens to content.ts
 * - Handle URL changes for Tutor Mode proactive tips
 */

declare const WORKER_URL: string;
declare const CLICKY_API_KEY: string;

import type { Message, ActiveFlow, PreloadedStep, ClickyStorageState, BackgroundMessage, ContentMessage } from './types';

const ONBOARDING_FLOW_SEQUENCE = [
  'upload-first-batch',
  'review-denial',
  'upload-era',
  'view-scrub-rules',
  'view-memory-patterns',
];

// Cache a verified Altair session for 5 minutes to avoid /api/users/me on every message
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      isFirstInstall: true,
      preferences: { tutorMode: true, voiceEnabled: false },
      onboardingProgress: { currentFlowIndex: 0, completedFlows: [] },
    } satisfies ClickyStorageState);

    const tabs = await getAltairTabs();
    for (const tab of tabs) {
      if (tab.id) sendToTab(tab.id, { type: 'SHOW_WELCOME' });
    }
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  handleMessage(message, tabId)
    .then(sendResponse)
    .catch((error) => {
      console.error('[background] unhandled error:', error);
      sendResponse(null);
    });
  return true;
});

async function handleMessage(message: BackgroundMessage, senderTabId?: number): Promise<unknown> {
  switch (message.type) {
    case 'TRANSCRIPT_READY':
      await processTranscript(message.text, senderTabId);
      break;

    case 'STEP_COMPLETE':
      await advanceFlow(senderTabId);
      break;

    case 'CLOSE_FLOW':
      await chrome.storage.local.remove('activeFlow');
      break;

    case 'URL_CHANGED':
      await handleUrlChanged(message.url, senderTabId);
      break;

    case 'START_FLOW':
      await startFlow(message.slug, senderTabId);
      break;

    case 'START_ONBOARDING':
      await startOnboarding(senderTabId);
      break;

    case 'GET_STATE':
      return loadState();

    case 'SET_TUTOR_MODE': {
      const state = await loadState();
      await chrome.storage.local.set({
        preferences: { ...state.preferences, tutorMode: message.enabled },
      });
      break;
    }

    case 'SET_VOICE_ENABLED': {
      const state = await loadState();
      await chrome.storage.local.set({
        preferences: { ...state.preferences, voiceEnabled: message.enabled },
      });
      break;
    }

    case 'GET_TRANSCRIBE_TOKEN':
      return getTranscribeToken(senderTabId);
  }
  return null;
}

// ─── Altair session validation ────────────────────────────────────────────────

// Calls /api/users/me from within the Altair tab so the browser's existing
// session cookies are sent automatically. Returns true if the user is logged in.
async function verifyAltairSession(tabId: number): Promise<boolean> {
  const { altairSessionExpiry } = await chrome.storage.local.get('altairSessionExpiry') as {
    altairSessionExpiry?: number;
  };
  if (altairSessionExpiry && altairSessionExpiry > Date.now()) return true;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const resp = await fetch(`${window.location.origin}/api/users/me`, {
            credentials: 'include',
          });
          return resp.ok;
        } catch {
          return false;
        }
      },
    });

    const isValid = results[0]?.result === true;
    if (isValid) {
      await chrome.storage.local.set({
        altairSessionExpiry: Date.now() + SESSION_CACHE_TTL_MS,
      });
    }
    return isValid;
  } catch {
    return false;
  }
}

// ─── Authenticated Worker fetch ───────────────────────────────────────────────

// All Worker requests carry the pre-shared API key. Session validation is done
// separately (once per SESSION_CACHE_TTL_MS) before calling this.
async function fetchWorker(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> ?? {}),
      'X-Clicky-Api-Key': CLICKY_API_KEY,
    },
  });
}

// ─── Transcription token proxy ────────────────────────────────────────────────

async function getTranscribeToken(tabId?: number): Promise<{ token: string } | null> {
  if (tabId && !(await verifyAltairSession(tabId))) return null;
  const response = await fetchWorker('/transcribe-token', { method: 'POST' });
  if (!response.ok) return null;
  return response.json() as Promise<{ token: string }>;
}

// ─── Core chat flow ───────────────────────────────────────────────────────────

async function processTranscript(transcript: string, tabId?: number): Promise<void> {
  // Gate on Altair session — only logged-in users can use Clicky
  if (tabId && !(await verifyAltairSession(tabId))) {
    sendToTab(tabId, {
      type: 'SHOW_MESSAGE',
      speechText: 'Please log in to Altair to use Clicky.',
      audioDataUrl: null,
    });
    return;
  }

  const state = await loadState();
  const { activeFlow, preferences } = state;

  const isPrecomputedQA = !!(activeFlow?.steps);
  console.log('[clicky] processTranscript', {
    transcript,
    activeFlowSlug: activeFlow?.slug ?? null,
    mode: isPrecomputedQA ? 'precomputed-qa' : activeFlow ? 'llm-flow' : 'llm-freeform',
    stepIndex: activeFlow?.stepIndex ?? null,
    stepId: activeFlow?.stepId ?? null,
  });

  const messages: Message[] = [
    ...(activeFlow?.conversationHistory ?? []),
    { role: 'user', content: transcript },
  ];

  const url = tabId ? await getTabUrl(tabId) : '';

  const response = await fetchWorker('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      url,
      domExcerpt: '',
      flowSlug: activeFlow?.slug,
      stepId: activeFlow?.stepId ?? undefined,
    }),
  });

  if (!response.ok) {
    console.error('[background] /chat error:', response.status, await response.text());
    return;
  }

  const resolvedFlowSlug = response.headers.get('x-clicky-flow-slug') || activeFlow?.slug || null;
  const fullText = await accumulateSSEStream(response);

  console.log('[clicky] LLM response', {
    resolvedFlowSlug,
    fullText,
  });

  const anchorMatch = fullText.match(/\[ANCHOR:([^\]]+)\]/);
  const clickMatch = fullText.match(/\[CLICK:([^\]]+)\]/);
  const anchor = anchorMatch?.[1] ?? clickMatch?.[1] ?? null;
  const autoClick = !!clickMatch;

  const flowDone = fullText.includes('FLOW_DONE');
  const stepComplete = fullText.includes('STEP_COMPLETE') && !flowDone;

  console.log('[clicky] LLM signals', { anchor, autoClick, flowDone, stepComplete, isPrecomputedQA });

  const signalIdx = flowDone
    ? fullText.indexOf('FLOW_DONE')
    : stepComplete
    ? fullText.indexOf('STEP_COMPLETE')
    : -1;
  const textToSpeak = signalIdx >= 0 ? fullText.slice(0, signalIdx) : fullText;
  const speechText = textToSpeak
    .replace(/\[ANCHOR:[^\]]+\]/g, '')
    .replace(/\[CLICK:[^\]]+\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const updatedHistory: Message[] = [
    ...messages,
    { role: 'assistant', content: speechText || fullText },
  ];

  if (resolvedFlowSlug && !activeFlow) {
    await chrome.storage.local.set({
      activeFlow: {
        slug: resolvedFlowSlug,
        stepId: null,
        conversationHistory: updatedHistory,
        startedAt: Date.now(),
      } satisfies ActiveFlow,
    });
  } else if (activeFlow && !flowDone) {
    await chrome.storage.local.set({
      activeFlow: { ...activeFlow, conversationHistory: updatedHistory } satisfies ActiveFlow,
    });
  }

  const audioDataUrl = preferences?.voiceEnabled !== false
    ? await fetchTTSDataUrl(speechText)
    : null;

  // During a pre-computed flow, LLM is only used for Q&A — don't advance or terminate the flow
  const isPrecomputed = !!(activeFlow?.steps);

  if (tabId) {
    const msg: ContentMessage = (flowDone && !isPrecomputed)
      ? { type: 'FLOW_DONE', anchor, autoClick, speechText, audioDataUrl }
      : isPrecomputed
      ? { type: 'SHOW_MESSAGE', speechText, audioDataUrl }
      : { type: 'SHOW_STEP', anchor, autoClick, speechText, audioDataUrl, flowSlug: resolvedFlowSlug, hasNext: stepComplete };
    sendToTab(tabId, msg);
  }

  if (flowDone && !isPrecomputed) {
    await chrome.storage.local.remove('activeFlow');
    await advanceOnboardingSequence(resolvedFlowSlug, tabId);
  }
}

async function advanceFlow(tabId?: number): Promise<void> {
  const state = await loadState();
  const { activeFlow, preferences } = state;

  if (!activeFlow) return;

  if (Date.now() - activeFlow.startedAt > 30 * 60 * 1000) {
    await chrome.storage.local.remove('activeFlow');
    if (tabId) {
      sendToTab(tabId, {
        type: 'SHOW_MESSAGE',
        speechText: 'That flow timed out. Start a new one whenever you\'re ready.',
        audioDataUrl: null,
      });
    }
    return;
  }

  // Pre-computed path — advance step locally, no LLM call
  if (activeFlow.steps && activeFlow.stepIndex !== undefined) {
    const nextIndex = activeFlow.stepIndex + 1;
    console.log('[clicky] advanceFlow (precomputed)', { slug: activeFlow.slug, from: activeFlow.stepIndex, to: nextIndex, total: activeFlow.steps.length });

    if (nextIndex >= activeFlow.steps.length) {
      console.log('[clicky] flow complete', { slug: activeFlow.slug });
      const completionText = activeFlow.completionMessage || 'All done!';
      const audioDataUrl = preferences?.voiceEnabled !== false ? await fetchTTSDataUrl(completionText) : null;
      if (tabId) {
        sendToTab(tabId, { type: 'FLOW_DONE', anchor: null, autoClick: false, speechText: completionText, audioDataUrl });
      }
      await chrome.storage.local.remove('activeFlow');
      await advanceOnboardingSequence(activeFlow.slug, tabId);
      return;
    }

    const nextStep = activeFlow.steps[nextIndex];
    await chrome.storage.local.set({
      activeFlow: { ...activeFlow, stepId: nextStep.id, stepIndex: nextIndex },
    });
    await sendPreloadedStep(nextStep, activeFlow.slug, tabId);
    return;
  }

  // LLM-driven fallback
  await processTranscript('[The user completed the step. Move to the next step.]', tabId);
}

async function startFlow(slug: string, tabId?: number): Promise<void> {
  console.log('[clicky] startFlow', { slug });

  const stepsResponse = await fetchWorker('/flow-steps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  }).catch((err) => { console.error('[clicky] /flow-steps fetch error:', err); return null; });

  if (stepsResponse?.ok) {
    const { steps, completionMessage } = await stepsResponse.json() as { steps: PreloadedStep[]; completionMessage: string };
    console.log('[clicky] pre-computed steps loaded', { slug, stepCount: steps.length, steps, completionMessage });

    if (steps.length > 0) {
      await chrome.storage.local.set({
        activeFlow: {
          slug,
          stepId: steps[0].id,
          conversationHistory: [],
          startedAt: Date.now(),
          steps,
          stepIndex: 0,
          completionMessage,
        } satisfies ActiveFlow,
      });
      await sendPreloadedStep(steps[0], slug, tabId);
      return;
    }
    console.warn('[clicky] /flow-steps returned 0 steps — falling back to LLM', { slug });
  } else {
    console.warn('[clicky] /flow-steps failed (status:', stepsResponse?.status, ') — falling back to LLM');
  }

  // Fallback: LLM-driven flow
  await chrome.storage.local.set({
    activeFlow: {
      slug,
      stepId: null,
      conversationHistory: [],
      startedAt: Date.now(),
    } satisfies ActiveFlow,
  });
  await processTranscript(`Begin guiding me through the flow: ${slug}`, tabId);
}

async function sendPreloadedStep(step: PreloadedStep, flowSlug: string, tabId?: number): Promise<void> {
  console.log('[clicky] sendPreloadedStep', { flowSlug, stepId: step.id, anchor: step.anchor, autoClick: step.autoClick, instruction: step.instruction });
  const { preferences } = await loadState();
  const audioDataUrl = preferences?.voiceEnabled !== false ? await fetchTTSDataUrl(step.instruction) : null;
  if (tabId) {
    sendToTab(tabId, {
      type: 'SHOW_STEP',
      anchor: step.anchor,
      autoClick: step.autoClick,
      speechText: step.instruction,
      audioDataUrl,
      flowSlug,
      hasNext: true,
    });
  }
}

async function startOnboarding(tabId?: number): Promise<void> {
  const { onboardingProgress } = await loadState();
  const index = onboardingProgress?.currentFlowIndex ?? 0;
  const slug = ONBOARDING_FLOW_SEQUENCE[index];
  if (slug) await startFlow(slug, tabId);
}

async function advanceOnboardingSequence(completedSlug: string | null, tabId?: number): Promise<void> {
  if (!completedSlug) return;
  const state = await loadState();
  const progress = state.onboardingProgress;
  if (!progress) return;

  const currentExpected = ONBOARDING_FLOW_SEQUENCE[progress.currentFlowIndex];
  if (currentExpected !== completedSlug) return;

  const nextIndex = progress.currentFlowIndex + 1;
  const completedFlows = [...progress.completedFlows, completedSlug];

  await chrome.storage.local.set({
    onboardingProgress: { currentFlowIndex: nextIndex, completedFlows },
  });

  const nextSlug = ONBOARDING_FLOW_SEQUENCE[nextIndex];
  if (nextSlug && tabId) {
    setTimeout(() => startFlow(nextSlug, tabId), 2000);
  }
}

// ─── Tutor Mode ───────────────────────────────────────────────────────────────

async function handleUrlChanged(url: string, tabId?: number): Promise<void> {
  const { preferences, activeFlow } = await loadState();
  if (activeFlow) return;
  if (!preferences?.tutorMode) return;
  if (tabId && !(await verifyAltairSession(tabId))) return;

  const response = await fetchWorker('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: `The user just navigated to ${url}. Offer a brief one-sentence proactive tip or ask if they need guidance — only if genuinely useful. If no tip is needed, respond with exactly: NO_TIP`,
      }],
      url,
      domExcerpt: '',
    }),
  });

  if (!response.ok) return;

  const text = await accumulateSSEStream(response);
  if (!text.trim() || text.includes('NO_TIP')) return;

  const audioDataUrl = preferences.voiceEnabled !== false
    ? await fetchTTSDataUrl(text)
    : null;

  if (tabId) {
    sendToTab(tabId, { type: 'SHOW_MESSAGE', speechText: text, audioDataUrl });
  }
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

async function fetchTTSDataUrl(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  try {
    const response = await fetchWorker('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return arrayBufferToDataUrl(buffer, 'audio/mpeg');
  } catch (error) {
    console.error('[background] TTS error:', error);
    return null;
  }
}

function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mimeType};base64,${btoa(binary)}`;
}

// ─── SSE stream accumulator ───────────────────────────────────────────────────

async function accumulateSSEStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        const parsed = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> };
        fullText += parsed.choices[0]?.delta?.content ?? '';
      } catch {
        // Ignore non-JSON SSE lines
      }
    }
  }

  return fullText;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadState(): Promise<ClickyStorageState> {
  return chrome.storage.local.get(null) as Promise<ClickyStorageState>;
}

async function getTabUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? '';
  } catch {
    return '';
  }
}

async function getAltairTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({
    url: ['https://altair-health.com/*', 'https://beta.altair-health.com/*'],
  });
}

function sendToTab(tabId: number, message: ContentMessage): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab not ready or content script not injected yet — safe to ignore
  });
}
