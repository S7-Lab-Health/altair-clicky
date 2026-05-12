"use strict";
(() => {
  // src/popup.ts
  var FLOWS = [
    { slug: "upload-first-batch", label: "Upload a Batch" },
    { slug: "review-denial", label: "Review a Denial" },
    { slug: "upload-era", label: "Upload an ERA" },
    { slug: "view-scrub-rules", label: "View Scrub Rules" },
    { slug: "find-patient", label: "Find a Patient" },
    { slug: "create-prior-auth", label: "Create Prior Auth" },
    { slug: "view-memory-patterns", label: "Memory Patterns" },
    { slug: "review-payer-intel", label: "Payer Intelligence" }
  ];
  async function init() {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const activeFlowEl = document.getElementById("active-flow");
    if (state?.activeFlow) {
      activeFlowEl.textContent = `Active: ${state.activeFlow.slug}`;
      activeFlowEl.style.display = "block";
    }
    const tutorToggle = document.getElementById("tutor-toggle");
    tutorToggle.checked = state?.preferences?.tutorMode ?? true;
    tutorToggle.addEventListener("change", () => {
      chrome.runtime.sendMessage({ type: "SET_TUTOR_MODE", enabled: tutorToggle.checked });
    });
    const voiceToggle = document.getElementById("voice-toggle");
    voiceToggle.checked = state?.preferences?.voiceEnabled ?? true;
    voiceToggle.addEventListener("change", () => {
      chrome.runtime.sendMessage({ type: "SET_VOICE_ENABLED", enabled: voiceToggle.checked });
    });
    document.getElementById("start-onboarding")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "START_ONBOARDING" });
      window.close();
    });
    const flowList = document.getElementById("flow-list");
    for (const flow of FLOWS) {
      const button = document.createElement("button");
      button.className = "flow-button";
      button.textContent = flow.label;
      button.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "START_FLOW", slug: flow.slug });
        window.close();
      });
      flowList.appendChild(button);
    }
    const progress = state?.onboardingProgress;
    if (progress && progress.currentFlowIndex > 0) {
      const progressEl = document.getElementById("onboarding-progress");
      progressEl.textContent = `Onboarding: ${progress.currentFlowIndex} / 5 flows complete`;
      progressEl.style.display = "block";
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    init().catch(console.error);
  });
})();
