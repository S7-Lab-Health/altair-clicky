"use strict";
(() => {
  // src/background.ts
  var ONBOARDING_FLOW_SEQUENCE = [
    "upload-first-batch",
    "review-denial",
    "upload-era",
    "view-scrub-rules",
    "view-memory-patterns"
  ];
  var SESSION_CACHE_TTL_MS = 5 * 60 * 1e3;
  function isAudioEnabled(preferences) {
    return false;
  }
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === "install") {
      await chrome.storage.local.set({
        isFirstInstall: true,
        preferences: { tutorMode: true, voiceEnabled: false },
        onboardingProgress: { currentFlowIndex: 0, completedFlows: [] }
      });
      const tabs = await getAltairTabs();
      for (const tab of tabs) {
        if (tab.id) sendToTab(tab.id, { type: "SHOW_WELCOME" });
      }
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    handleMessage(message, tabId).then(sendResponse).catch((error) => {
      console.error("[background] unhandled error:", error);
      sendResponse(null);
    });
    return true;
  });
  async function handleMessage(message, senderTabId) {
    switch (message.type) {
      case "TRANSCRIPT_READY":
        await processTranscript(message.text, senderTabId);
        break;
      case "STEP_COMPLETE":
        await advanceFlow(senderTabId);
        break;
      case "CLOSE_FLOW":
        await chrome.storage.local.remove("activeFlow");
        break;
      case "URL_CHANGED":
        await handleUrlChanged(message.url, senderTabId);
        break;
      case "START_FLOW":
        await startFlow(message.slug, senderTabId);
        break;
      case "START_ONBOARDING":
        await startOnboarding(senderTabId);
        break;
      case "GET_STATE":
        return loadState();
      case "SET_TUTOR_MODE": {
        const state = await loadState();
        await chrome.storage.local.set({
          preferences: { ...state.preferences, tutorMode: message.enabled }
        });
        break;
      }
      case "SET_VOICE_ENABLED": {
        const state = await loadState();
        await chrome.storage.local.set({
          preferences: { ...state.preferences, voiceEnabled: message.enabled }
        });
        break;
      }
      case "GET_TRANSCRIBE_TOKEN":
        return getTranscribeToken(senderTabId);
    }
    return null;
  }
  async function verifyAltairSession(tabId) {
    const { altairSessionExpiry } = await chrome.storage.local.get("altairSessionExpiry");
    if (altairSessionExpiry && altairSessionExpiry > Date.now()) return true;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          try {
            const resp = await fetch(`${window.location.origin}/api/users/me`, {
              credentials: "include"
            });
            return resp.ok;
          } catch {
            return false;
          }
        }
      });
      const isValid = results[0]?.result === true;
      if (isValid) {
        await chrome.storage.local.set({
          altairSessionExpiry: Date.now() + SESSION_CACHE_TTL_MS
        });
      }
      return isValid;
    } catch {
      return false;
    }
  }
  async function fetchWorker(path, options = {}) {
    return fetch(`${"https://clicky-proxy.young-shadow-1ff3.workers.dev"}${path}`, {
      ...options,
      headers: {
        ...options.headers ?? {},
        "X-Clicky-Api-Key": "86e23cbfcef7fb6a5e1adfb3f2259d9327761c0123058c52354bfd7120f3d518"
      }
    });
  }
  async function getTranscribeToken(tabId) {
    if (tabId && !await verifyAltairSession(tabId)) return null;
    const response = await fetchWorker("/transcribe-token", { method: "POST" });
    if (!response.ok) return null;
    return response.json();
  }
  async function processTranscript(transcript, tabId) {
    if (tabId && !await verifyAltairSession(tabId)) {
      sendToTab(tabId, {
        type: "SHOW_MESSAGE",
        speechText: "Please log in to Altair to use Clicky.",
        audioDataUrl: null
      });
      return;
    }
    const state = await loadState();
    const { activeFlow, preferences } = state;
    const isPrecomputedQA = !!activeFlow?.steps;
    console.log("[clicky] processTranscript", {
      transcript,
      activeFlowSlug: activeFlow?.slug ?? null,
      mode: isPrecomputedQA ? "precomputed-qa" : activeFlow ? "llm-flow" : "llm-freeform",
      stepIndex: activeFlow?.stepIndex ?? null,
      stepId: activeFlow?.stepId ?? null
    });
    const messages = [
      ...activeFlow?.conversationHistory ?? [],
      { role: "user", content: transcript }
    ];
    const url = tabId ? await getTabUrl(tabId) : "";
    const response = await fetchWorker("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        url,
        domExcerpt: "",
        flowSlug: activeFlow?.slug,
        stepId: activeFlow?.stepId ?? void 0
      })
    });
    if (!response.ok) {
      console.error("[background] /chat error:", response.status, await response.text());
      return;
    }
    const resolvedFlowSlug = response.headers.get("x-clicky-flow-slug") || activeFlow?.slug || null;
    const fullText = await accumulateSSEStream(response);
    console.log("[clicky] LLM response", {
      resolvedFlowSlug,
      fullText
    });
    const anchorMatch = fullText.match(/\[ANCHOR:([^\]]+)\]/);
    const clickMatch = fullText.match(/\[CLICK:([^\]]+)\]/);
    const anchor = anchorMatch?.[1] ?? clickMatch?.[1] ?? null;
    const autoClick = !!clickMatch;
    const flowDone = fullText.includes("FLOW_DONE");
    const stepComplete = fullText.includes("STEP_COMPLETE") && !flowDone;
    console.log("[clicky] LLM signals", { anchor, autoClick, flowDone, stepComplete, isPrecomputedQA });
    const signalIdx = flowDone ? fullText.indexOf("FLOW_DONE") : stepComplete ? fullText.indexOf("STEP_COMPLETE") : -1;
    const textToSpeak = signalIdx >= 0 ? fullText.slice(0, signalIdx) : fullText;
    const speechText = textToSpeak.replace(/\[ANCHOR:[^\]]+\]/g, "").replace(/\[CLICK:[^\]]+\]/g, "").replace(/\s{2,}/g, " ").trim();
    const updatedHistory = [
      ...messages,
      { role: "assistant", content: speechText || fullText }
    ];
    if (resolvedFlowSlug && !activeFlow) {
      console.log("[clicky] intent matched \u2192 starting pre-computed flow", { resolvedFlowSlug });
      await startFlow(resolvedFlowSlug, tabId);
      return;
    } else if (activeFlow && !flowDone) {
      await chrome.storage.local.set({
        activeFlow: { ...activeFlow, conversationHistory: updatedHistory }
      });
    }
    const audioDataUrl = isAudioEnabled(preferences) ? await fetchTTSDataUrl(speechText) : null;
    const isPrecomputed = !!activeFlow?.steps;
    if (tabId) {
      const msg = flowDone && !isPrecomputed ? { type: "FLOW_DONE", anchor, autoClick, speechText, audioDataUrl } : isPrecomputed ? { type: "SHOW_MESSAGE", speechText, audioDataUrl } : { type: "SHOW_STEP", anchor, autoClick, speechText, audioDataUrl, flowSlug: resolvedFlowSlug, hasNext: stepComplete };
      sendToTab(tabId, msg);
    }
    if (flowDone && !isPrecomputed) {
      await chrome.storage.local.remove("activeFlow");
      await advanceOnboardingSequence(resolvedFlowSlug, tabId);
    }
  }
  async function advanceFlow(tabId) {
    const state = await loadState();
    const { activeFlow, preferences } = state;
    if (!activeFlow) return;
    if (Date.now() - activeFlow.startedAt > 30 * 60 * 1e3) {
      await chrome.storage.local.remove("activeFlow");
      if (tabId) {
        sendToTab(tabId, {
          type: "SHOW_MESSAGE",
          speechText: "That flow timed out. Start a new one whenever you're ready.",
          audioDataUrl: null
        });
      }
      return;
    }
    if (activeFlow.steps && activeFlow.stepIndex !== void 0) {
      const nextIndex = activeFlow.stepIndex + 1;
      console.log("[clicky] advanceFlow (precomputed)", { slug: activeFlow.slug, from: activeFlow.stepIndex, to: nextIndex, total: activeFlow.steps.length });
      if (nextIndex >= activeFlow.steps.length) {
        console.log("[clicky] flow complete", { slug: activeFlow.slug });
        const completionText = activeFlow.completionMessage || "All done!";
        const audioDataUrl = isAudioEnabled(preferences) ? await fetchTTSDataUrl(completionText) : null;
        if (tabId) {
          sendToTab(tabId, { type: "FLOW_DONE", anchor: null, autoClick: false, speechText: completionText, audioDataUrl });
        }
        await chrome.storage.local.remove("activeFlow");
        await advanceOnboardingSequence(activeFlow.slug, tabId);
        return;
      }
      const nextStep = activeFlow.steps[nextIndex];
      await chrome.storage.local.set({
        activeFlow: { ...activeFlow, stepId: nextStep.id, stepIndex: nextIndex }
      });
      await sendPreloadedStep(nextStep, activeFlow.slug, tabId);
      return;
    }
    await processTranscript("[The user completed the step. Move to the next step.]", tabId);
  }
  async function startFlow(slug, tabId) {
    console.log("[clicky] startFlow", { slug });
    const stepsResponse = await fetchWorker("/flow-steps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug })
    }).catch((err) => {
      console.error("[clicky] /flow-steps fetch error:", err);
      return null;
    });
    if (stepsResponse?.ok) {
      const { steps, completionMessage } = await stepsResponse.json();
      console.log("[clicky] pre-computed steps loaded", { slug, stepCount: steps.length, steps, completionMessage });
      if (steps.length > 0) {
        await chrome.storage.local.set({
          activeFlow: {
            slug,
            stepId: steps[0].id,
            conversationHistory: [],
            startedAt: Date.now(),
            steps,
            stepIndex: 0,
            completionMessage
          }
        });
        await sendPreloadedStep(steps[0], slug, tabId);
        return;
      }
      console.warn("[clicky] /flow-steps returned 0 steps \u2014 falling back to LLM", { slug });
    } else {
      console.warn("[clicky] /flow-steps failed (status:", stepsResponse?.status, ") \u2014 falling back to LLM");
    }
    await chrome.storage.local.set({
      activeFlow: {
        slug,
        stepId: null,
        conversationHistory: [],
        startedAt: Date.now()
      }
    });
    await processTranscript(`Begin guiding me through the flow: ${slug}`, tabId);
  }
  async function sendPreloadedStep(step, flowSlug, tabId) {
    console.log("[clicky] sendPreloadedStep", { flowSlug, stepId: step.id, anchor: step.anchor, autoClick: step.autoClick, instruction: step.instruction });
    if (!tabId) return;
    sendToTab(tabId, {
      type: "SHOW_STEP",
      anchor: step.anchor,
      autoClick: step.autoClick,
      speechText: step.instruction,
      audioDataUrl: null,
      flowSlug,
      hasNext: true
    });
    const { preferences } = await loadState();
    if (isAudioEnabled(preferences)) {
      fetchTTSDataUrl(step.instruction).then((audioDataUrl) => {
        if (audioDataUrl) sendToTab(tabId, { type: "PLAY_AUDIO", audioDataUrl });
      });
    }
  }
  async function startOnboarding(tabId) {
    const { onboardingProgress } = await loadState();
    const index = onboardingProgress?.currentFlowIndex ?? 0;
    const slug = ONBOARDING_FLOW_SEQUENCE[index];
    if (slug) await startFlow(slug, tabId);
  }
  async function advanceOnboardingSequence(completedSlug, tabId) {
    if (!completedSlug) return;
    const state = await loadState();
    const progress = state.onboardingProgress;
    if (!progress) return;
    const currentExpected = ONBOARDING_FLOW_SEQUENCE[progress.currentFlowIndex];
    if (currentExpected !== completedSlug) return;
    const nextIndex = progress.currentFlowIndex + 1;
    const completedFlows = [...progress.completedFlows, completedSlug];
    await chrome.storage.local.set({
      onboardingProgress: { currentFlowIndex: nextIndex, completedFlows }
    });
    const nextSlug = ONBOARDING_FLOW_SEQUENCE[nextIndex];
    if (nextSlug && tabId) {
      setTimeout(() => startFlow(nextSlug, tabId), 2e3);
    }
  }
  async function handleUrlChanged(url, tabId) {
    const { preferences, activeFlow } = await loadState();
    if (activeFlow?.steps && activeFlow.stepIndex !== void 0) {
      const currentStep = activeFlow.steps[activeFlow.stepIndex];
      console.log("[clicky] URL changed during flow \u2014 re-sending step", { url, stepId: currentStep.id });
      await sendPreloadedStep(currentStep, activeFlow.slug, tabId);
      return;
    }
    if (activeFlow) return;
    if (!preferences?.tutorMode) return;
    if (tabId && !await verifyAltairSession(tabId)) return;
    const response = await fetchWorker("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `The user just navigated to ${url}. Offer a brief one-sentence proactive tip or ask if they need guidance \u2014 only if genuinely useful. If no tip is needed, respond with exactly: NO_TIP`
        }],
        url,
        domExcerpt: ""
      })
    });
    if (!response.ok) return;
    const text = await accumulateSSEStream(response);
    if (!text.trim() || text.includes("NO_TIP")) return;
    const audioDataUrl = isAudioEnabled(preferences) ? await fetchTTSDataUrl(text) : null;
    if (tabId) {
      sendToTab(tabId, { type: "SHOW_MESSAGE", speechText: text, audioDataUrl });
    }
  }
  async function fetchTTSDataUrl(text) {
    if (!text.trim()) return null;
    try {
      const response = await fetchWorker("/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" })
      });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      return arrayBufferToDataUrl(buffer, "audio/mpeg");
    } catch (error) {
      console.error("[background] TTS error:", error);
      return null;
    }
  }
  function arrayBufferToDataUrl(buffer, mimeType) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${mimeType};base64,${btoa(binary)}`;
  }
  async function accumulateSSEStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          fullText += parsed.choices[0]?.delta?.content ?? "";
        } catch {
        }
      }
    }
    return fullText;
  }
  async function loadState() {
    return chrome.storage.local.get(null);
  }
  async function getTabUrl(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? "";
    } catch {
      return "";
    }
  }
  async function getAltairTabs() {
    return chrome.tabs.query({
      url: ["https://altair-health.com/*", "https://beta.altair-health.com/*"]
    });
  }
  function sendToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
    });
  }
})();
