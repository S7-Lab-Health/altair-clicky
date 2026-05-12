"use strict";
(() => {
  // src/content.ts
  var currentAudio = null;
  var urlChangeDebounceTimer = null;
  (async () => {
    try {
      const resp = await fetch(`${window.location.origin}/api/users/me`, { credentials: "include" });
      if (!resp.ok) return;
    } catch {
      return;
    }
    injectFloatingButton();
    injectTextPanel();
    patchHistoryForUrlDetection();
  })();
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case "SHOW_STEP":
        appendStepMessage(message.speechText, message.hasNext);
        playAudio(message.audioDataUrl);
        if (message.anchor) {
          waitForAnchor(message.anchor, 3e3).then((el) => {
            if (el) {
              highlightElement(el);
              if (message.autoClick) setTimeout(() => el.click(), 500);
            }
          });
        }
        break;
      case "FLOW_DONE":
        appendStepMessage(message.speechText, false);
        playAudio(message.audioDataUrl);
        if (message.anchor) {
          waitForAnchor(message.anchor, 3e3).then((el) => {
            if (el) {
              highlightElement(el);
              if (message.autoClick) setTimeout(() => el.click(), 500);
            }
          });
        }
        break;
      case "SHOW_MESSAGE":
        appendStepMessage(message.speechText, false, false);
        playAudio(message.audioDataUrl);
        break;
      case "SHOW_WELCOME":
        appendStepMessage("Hi! I'm Clicky \u2014 your Altair guide. Click the button to ask me anything.", false);
        break;
      case "CLEAR_OVERLAY":
        hideClickyPanel();
        break;
    }
  });
  function injectFloatingButton() {
    if (document.getElementById("clicky-trigger")) return;
    const button = document.createElement("button");
    button.id = "clicky-trigger";
    button.setAttribute("aria-label", "Ask Clicky");
    button.title = "Ask Clicky";
    button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
  </svg>`;
    button.addEventListener("click", toggleTextPanel);
    document.body.appendChild(button);
  }
  function injectTextPanel() {
    if (document.getElementById("clicky-text-panel")) return;
    const panel = document.createElement("div");
    panel.id = "clicky-text-panel";
    panel.setAttribute("aria-label", "Ask Clicky");
    const input = document.createElement("input");
    input.id = "clicky-text-input";
    input.type = "text";
    input.placeholder = "Ask Clicky anything\u2026";
    input.setAttribute("aria-label", "Ask Clicky");
    const sendBtn = document.createElement("button");
    sendBtn.id = "clicky-send-btn";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
  </svg>`;
    const submitText = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      hideTextPanel();
      try {
        const message = { type: "TRANSCRIPT_READY", text };
        chrome.runtime.sendMessage(message);
      } catch {
        appendStepMessage("Extension reloaded \u2014 please refresh this page to use Clicky.", false);
      }
    };
    sendBtn.addEventListener("click", submitText);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitText();
    });
    panel.appendChild(input);
    panel.appendChild(sendBtn);
    document.body.appendChild(panel);
  }
  function toggleTextPanel() {
    const panel = document.getElementById("clicky-text-panel");
    if (!panel) return;
    const isVisible = panel.classList.contains("clicky-panel-visible");
    if (isVisible) {
      hideTextPanel();
    } else {
      panel.classList.add("clicky-panel-visible");
      setTimeout(() => document.getElementById("clicky-text-input")?.focus(), 50);
    }
  }
  function hideTextPanel() {
    document.getElementById("clicky-text-panel")?.classList.remove("clicky-panel-visible");
  }
  function waitForAnchor(name, timeoutMs) {
    const existing = document.querySelector(`[data-clicky-anchor="${name}"]`);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector(`[data-clicky-anchor="${name}"]`);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }
  function highlightElement(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const rect = el.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.className = "clicky-highlight";
    ring.style.cssText = `position:fixed;top:${rect.top - 4}px;left:${rect.left - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px;pointer-events:none;z-index:2147483646;border-radius:8px;`;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 8e3);
  }
  function ensureClickyPanel() {
    let panel = document.getElementById("clicky-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "clicky-panel";
    const header = document.createElement("div");
    header.id = "clicky-panel-header";
    const label = document.createElement("span");
    label.textContent = "Clicky";
    const closeBtn = document.createElement("button");
    closeBtn.id = "clicky-panel-close";
    closeBtn.setAttribute("aria-label", "Close Clicky");
    closeBtn.textContent = "\xD7";
    closeBtn.addEventListener("click", hideClickyPanel);
    header.appendChild(label);
    header.appendChild(closeBtn);
    const messages = document.createElement("div");
    messages.id = "clicky-panel-messages";
    panel.appendChild(header);
    panel.appendChild(messages);
    document.body.appendChild(panel);
    return panel;
  }
  function appendStepMessage(text, hasNext, isStep = true) {
    const panel = ensureClickyPanel();
    const messages = document.getElementById("clicky-panel-messages");
    if (isStep) messages.querySelectorAll(".clicky-next-btn").forEach((btn) => btn.remove());
    const msgEl = document.createElement("div");
    msgEl.className = "clicky-message";
    const p = document.createElement("p");
    p.className = "clicky-message-text";
    p.textContent = text;
    msgEl.appendChild(p);
    if (hasNext) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "clicky-next-btn";
      nextBtn.textContent = "Next \u2192";
      nextBtn.addEventListener("click", () => {
        nextBtn.remove();
        try {
          const msg = { type: "STEP_COMPLETE" };
          chrome.runtime.sendMessage(msg);
        } catch {
          appendStepMessage("Extension reloaded \u2014 please refresh this page to continue.", false);
        }
      });
      msgEl.appendChild(nextBtn);
    }
    messages.appendChild(msgEl);
    panel.classList.add("clicky-panel-chat-visible");
    messages.scrollTop = messages.scrollHeight;
  }
  function hideClickyPanel() {
    const panel = document.getElementById("clicky-panel");
    if (!panel) return;
    panel.classList.remove("clicky-panel-chat-visible");
    setTimeout(() => {
      const messages = document.getElementById("clicky-panel-messages");
      if (messages) messages.innerHTML = "";
      try {
        const msg = { type: "CLOSE_FLOW" };
        chrome.runtime.sendMessage(msg);
      } catch {
      }
    }, 220);
  }
  function playAudio(dataUrl) {
    if (!dataUrl) return;
    currentAudio?.pause();
    currentAudio = new Audio(dataUrl);
    currentAudio.play().catch((error) => console.error("[clicky] Audio play error:", error));
  }
  function patchHistoryForUrlDetection() {
    const originalPushState = history.pushState.bind(history);
    history.pushState = (...args) => {
      originalPushState(...args);
      scheduleUrlChangedNotification();
    };
    window.addEventListener("popstate", scheduleUrlChangedNotification);
  }
  function scheduleUrlChangedNotification() {
    if (urlChangeDebounceTimer !== null) clearTimeout(urlChangeDebounceTimer);
    urlChangeDebounceTimer = setTimeout(() => {
      const message = { type: "URL_CHANGED", url: location.href };
      chrome.runtime.sendMessage(message);
      urlChangeDebounceTimer = null;
    }, 800);
  }
})();
