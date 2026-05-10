import type { ClickyStorageState, BackgroundMessage } from './types';

const FLOWS: Array<{ slug: string; label: string }> = [
  { slug: 'upload-first-batch',  label: 'Upload a Batch' },
  { slug: 'review-denial',       label: 'Review a Denial' },
  { slug: 'upload-era',          label: 'Upload an ERA' },
  { slug: 'view-scrub-rules',    label: 'View Scrub Rules' },
  { slug: 'find-patient',        label: 'Find a Patient' },
  { slug: 'create-prior-auth',   label: 'Create Prior Auth' },
  { slug: 'view-memory-patterns', label: 'Memory Patterns' },
  { slug: 'review-payer-intel',  label: 'Payer Intelligence' },
];

async function init(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({ type: 'GET_STATE' } satisfies BackgroundMessage)) as ClickyStorageState | null;

  // Active flow indicator
  const activeFlowEl = document.getElementById('active-flow')!;
  if (state?.activeFlow) {
    activeFlowEl.textContent = `Active: ${state.activeFlow.slug}`;
    activeFlowEl.style.display = 'block';
  }

  // Tutor mode toggle
  const tutorToggle = document.getElementById('tutor-toggle') as HTMLInputElement;
  tutorToggle.checked = state?.preferences?.tutorMode ?? true;
  tutorToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_TUTOR_MODE', enabled: tutorToggle.checked } satisfies BackgroundMessage);
  });

  // Voice toggle
  const voiceToggle = document.getElementById('voice-toggle') as HTMLInputElement;
  voiceToggle.checked = state?.preferences?.voiceEnabled ?? true;
  voiceToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_VOICE_ENABLED', enabled: voiceToggle.checked } satisfies BackgroundMessage);
  });

  // Start onboarding
  document.getElementById('start-onboarding')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'START_ONBOARDING' } satisfies BackgroundMessage);
    window.close();
  });

  // Flow picker
  const flowList = document.getElementById('flow-list')!;
  for (const flow of FLOWS) {
    const button = document.createElement('button');
    button.className = 'flow-button';
    button.textContent = flow.label;
    button.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'START_FLOW', slug: flow.slug } satisfies BackgroundMessage);
      window.close();
    });
    flowList.appendChild(button);
  }

  // Onboarding progress
  const progress = state?.onboardingProgress;
  if (progress && progress.currentFlowIndex > 0) {
    const progressEl = document.getElementById('onboarding-progress')!;
    progressEl.textContent = `Onboarding: ${progress.currentFlowIndex} / 5 flows complete`;
    progressEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => { init().catch(console.error); });
