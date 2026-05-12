export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface PreloadedStep {
  id: string;
  instruction: string;
  anchor: string | null;
  autoClick: boolean;
}

export interface ActiveFlow {
  slug: string;
  stepId: string | null;
  conversationHistory: Message[];
  startedAt: number;
  steps?: PreloadedStep[];
  stepIndex?: number;
  completionMessage?: string;
}

export interface ClickyStorageState {
  activeFlow?: ActiveFlow;
  onboardingProgress?: {
    currentFlowIndex: number;
    completedFlows: string[];
  };
  preferences?: {
    tutorMode: boolean;
    voiceEnabled: boolean;
  };
  isFirstInstall?: boolean;
  altairSessionExpiry?: number;
}

// Messages sent from background → content
export type ContentMessage =
  | { type: 'SHOW_STEP'; anchor: string | null; autoClick: boolean; speechText: string; audioDataUrl: string | null; flowSlug: string | null; hasNext: boolean }
  | { type: 'FLOW_DONE'; anchor: string | null; autoClick: boolean; speechText: string; audioDataUrl: string | null }
  | { type: 'SHOW_MESSAGE'; speechText: string; audioDataUrl: string | null }
  | { type: 'SHOW_WELCOME' }
  | { type: 'CLEAR_OVERLAY' };

// Messages sent from content/popup → background
export type BackgroundMessage =
  | { type: 'TRANSCRIPT_READY'; text: string }
  | { type: 'STEP_COMPLETE' }
  | { type: 'CLOSE_FLOW' }
  | { type: 'URL_CHANGED'; url: string }
  | { type: 'START_FLOW'; slug: string }
  | { type: 'START_ONBOARDING' }
  | { type: 'GET_STATE' }
  | { type: 'SET_TUTOR_MODE'; enabled: boolean }
  | { type: 'SET_VOICE_ENABLED'; enabled: boolean }
  | { type: 'GET_TRANSCRIBE_TOKEN' };
