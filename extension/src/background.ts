/**
 * background.ts — MV3 service worker
 *
 * Responsibilities:
 * - Receive transcript from content.ts → call Worker /chat → send step back
 * - Manage active flow state in chrome.storage.local (never in-memory — SW restarts after 30s idle)
 * - Fetch TTS audio from Worker → encode as base64 data URL → send to content.ts for playback
 * - Handle URL changes for Tutor Mode proactive tips
 */

declare const WORKER_URL: string;

import type { Message, ActiveFlow, ClickyStorageState, BackgroundMessage, ContentMessage } from './types';

const ONBOARDING_FLOW_SEQUENCE = [
  'upload-first-batch',
  'review-denial',
  'upload-era',
  'view-scrub-rules',
  'view-memory-patterns',
];

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      isFirstInstall: true,
      preferences: { tutorMode: true, voiceEnabled: true },
      onboardingProgress: { currentFlowIndex: 0, completedFlows: [] },
    } satisfies ClickyStorageState);

    // Welcome message on first install
    const tabs = await getAltairTabs();
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WELCOME' } satisfies ContentMessage);
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
  return true; // Keep port open for async sendResponse
});

async function handleMessage(message: BackgroundMessage, senderTabId?: number): Promise<unknown> {
  switch (message.type) {
    case 'TRANSCRIPT_READY':
      await processTranscript(message.text, senderTabId);
      break;

    case 'STEP_COMPLETE':
      await advanceFlow(senderTabId);
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
  }
  return null;
}

// ─── Core chat flow ───────────────────────────────────────────────────────────

async function processTranscript(transcript: string, tabId?: number): Promise<void> {
  const state = await loadState();
  const { activeFlow, preferences } = state;

  const messages: Message[] = [
    ...(activeFlow?.conversationHistory ?? []),
    { role: 'user', content: transcript },
  ];

  const url = tabId ? await getTabUrl(tabId) : '';

  const response = await fetch(`${WORKER_URL}/chat`, {
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

  const updatedHistory: Message[] = [
    ...messages,
    { role: 'assistant', content: fullText },
  ];

  // Parse [ANCHOR:name] token — strip it from spoken text
  const anchorMatch = fullText.match(/\[ANCHOR:([^\]]+)\]/);
  const anchor = anchorMatch?.[1] ?? null;
  const stepComplete = fullText.includes('STEP_COMPLETE');
  const speechText = fullText
    .replace(/\[ANCHOR:[^\]]+\]/g, '')
    .replace(/STEP_COMPLETE/g, '')
    .trim();

  // Persist updated flow state before doing anything async (TTS fetch)
  if (resolvedFlowSlug && !activeFlow) {
    await chrome.storage.local.set({
      activeFlow: {
        slug: resolvedFlowSlug,
        stepId: null,
        conversationHistory: updatedHistory,
        startedAt: Date.now(),
      } satisfies ActiveFlow,
    });
  } else if (activeFlow) {
    await chrome.storage.local.set({
      activeFlow: { ...activeFlow, conversationHistory: updatedHistory } satisfies ActiveFlow,
    });
  }

  const audioDataUrl = preferences?.voiceEnabled !== false
    ? await fetchTTSDataUrl(speechText)
    : null;

  if (tabId) {
    const msg: ContentMessage = stepComplete
      ? { type: 'FLOW_COMPLETE', anchor, speechText, audioDataUrl }
      : { type: 'SHOW_STEP', anchor, speechText, audioDataUrl, flowSlug: resolvedFlowSlug };
    chrome.tabs.sendMessage(tabId, msg);
  }

  if (stepComplete) {
    await chrome.storage.local.remove('activeFlow');
    // Advance onboarding sequence if applicable
    await advanceOnboardingSequence(resolvedFlowSlug, tabId);
  }
}

async function advanceFlow(tabId?: number): Promise<void> {
  // Re-enter conversation with a completion signal so Foundry moves to the next step
  await processTranscript('[The user completed the step. Move to the next step.]', tabId);
}

async function startFlow(slug: string, tabId?: number): Promise<void> {
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

  // Auto-start next onboarding flow after a brief pause
  const nextSlug = ONBOARDING_FLOW_SEQUENCE[nextIndex];
  if (nextSlug && tabId) {
    setTimeout(() => startFlow(nextSlug, tabId), 2000);
  }
}

// ─── Tutor Mode ───────────────────────────────────────────────────────────────

async function handleUrlChanged(url: string, tabId?: number): Promise<void> {
  const { preferences, activeFlow } = await loadState();
  if (activeFlow) return; // Don't interrupt an active guided flow
  if (!preferences?.tutorMode) return;

  const response = await fetch(`${WORKER_URL}/chat`, {
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
    chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_MESSAGE',
      speechText: text,
      audioDataUrl,
    } satisfies ContentMessage);
  }
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

async function fetchTTSDataUrl(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  try {
    const response = await fetch(`${WORKER_URL}/tts`, {
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
