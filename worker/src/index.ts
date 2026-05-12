/**
 * Clicky Proxy Worker
 *
 * Routes:
 *   POST /chat              → Azure AI Foundry (intent classify → flow inject → stream)
 *   GET  /flow/:slug        → Fetch a flow article from KB_FLOWS KV
 *   GET  /flows             → List all flow slugs + aliases
 *   POST /tts               → ElevenLabs TTS API
 *   POST /transcribe-token  → AssemblyAI ephemeral token
 *
 * All routes (except OPTIONS preflight) require a valid Entra ID Bearer token.
 */

export interface Env {
  AZURE_FOUNDRY_ENDPOINT: string;
  AZURE_FOUNDRY_KEY: string;
  FOUNDRY_MAIN_MODEL: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  KB_FLOWS: KVNamespace;
  CLICKY_API_KEY: string;
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages: Message[];
  url: string;
  domExcerpt: string;
  flowSlug?: string;
  stepId?: string;
}

interface FlowIndexEntry {
  slug: string;
  title: string;
  aliases: string[];
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Clicky-Api-Key',
};

// ─── System prompt ────────────────────────────────────────────────────────────

const CLICKY_SYSTEM_PROMPT = `You are Clicky, an onboarding guide built into Altair, a medical billing platform.
You help billing staff navigate the app through step-by-step guidance.
Rules:
- Be concise and friendly. One or two sentences per step maximum.
- When referencing a UI element, use one of two tokens immediately after naming it:
  - [CLICK:anchor-name] — for navigation links, buttons that open dialogs, or any action Clicky can safely perform automatically. Clicky will highlight and click the element for the user.
  - [ANCHOR:anchor-name] — for elements the user must interact with themselves (form fields, dropdowns, file pickers, confirm/submit buttons).
  Example: "Click Payments & Denials [CLICK:Payments & Denials] in the sidebar."
  Example: "Select your billing account [ANCHOR:Billing Account] from the dropdown."
- When you have described a step the user needs to perform, output STEP_COMPLETE on its own line. The user will click "Next →" when ready for the next step.
- When the entire guided flow is finished and there are no more steps, output FLOW_DONE on its own line instead of STEP_COMPLETE.
- Output only the current step's instruction. Do not preview upcoming steps.
- Never use markdown formatting — your responses are spoken aloud via text-to-speech.
- If asked an off-topic question mid-flow, answer it briefly, then resume the flow.
- CRITICAL: Follow the flow steps exactly as written. Never invent, add, or describe UI elements (buttons, filters, tabs, fields) that are not explicitly named in the flow step. If a step does not mention a filter, do not mention a filter.`;

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Validate API key on every non-OPTIONS request
    const authResult = requireAuth(request, env);
    if (authResult instanceof Response) return authResult;

    const url = new URL(request.url);

    try {
      if (request.method === 'POST') {
        if (url.pathname === '/chat') return handleChat(request, env);
        if (url.pathname === '/tts') return handleTTS(request, env);
        if (url.pathname === '/transcribe-token') return handleTranscribeToken(env);
      }

      if (request.method === 'GET') {
        const flowMatch = url.pathname.match(/^\/flow\/(.+)$/);
        if (flowMatch) return handleGetFlow(flowMatch[1], env);
        if (url.pathname === '/flows') return handleGetFlows(env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] error:`, error);
      return jsonResponse({ error: String(error) }, 500);
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireAuth(request: Request, env: Env): true | Response {
  const apiKey = request.headers.get('X-Clicky-Api-Key');
  if (apiKey !== env.CLICKY_API_KEY) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  return true;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body: ChatRequestBody = await request.json();
  const { messages, url, domExcerpt, stepId } = body;
  let { flowSlug } = body;

  // If no flowSlug, classify intent via local keyword matching (no extra LLM call)
  if (!flowSlug) {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    const indexJson = await env.KB_FLOWS.get('__index__');
    if (indexJson) {
      const flows = JSON.parse(indexJson) as FlowIndexEntry[];
      flowSlug = classifyIntentLocal(lastUserMessage, flows) ?? undefined;
    }
  }

  // Build system prompt, injecting flow step context when applicable
  let systemPrompt = CLICKY_SYSTEM_PROMPT;
  systemPrompt += `\n\nCurrent page: ${url}`;
  if (domExcerpt) systemPrompt += `\nVisible elements: ${domExcerpt}`;

  if (flowSlug) {
    const flowArticle = await env.KB_FLOWS.get(flowSlug);
    if (flowArticle) {
      systemPrompt += `\n\n${extractStepContext(flowArticle, stepId)}`;
    }
  }

  const foundryMessages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const foundryResponse = await fetch(
    `${env.AZURE_FOUNDRY_ENDPOINT}/openai/deployments/${env.FOUNDRY_MAIN_MODEL}/chat/completions?api-version=2024-02-01`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.AZURE_FOUNDRY_KEY,
      },
      body: JSON.stringify({
        messages: foundryMessages,
        stream: true,
      }),
    }
  );

  if (!foundryResponse.ok) {
    const errorText = await foundryResponse.text();
    console.error(`[/chat] Foundry error ${foundryResponse.status}: ${errorText}`);
    return new Response(errorText, {
      status: foundryResponse.status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  return new Response(foundryResponse.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-clicky-flow-slug': flowSlug ?? '',
    },
  });
}

function classifyIntentLocal(userMessage: string, flows: FlowIndexEntry[]): string | null {
  const msg = userMessage.toLowerCase();
  for (const flow of flows) {
    for (const alias of flow.aliases) {
      const words = alias.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0 && words.every(word => msg.includes(word))) {
        return flow.slug;
      }
    }
  }
  return null;
}

function extractStepContext(flowArticle: string, stepId?: string): string {
  const lines = flowArticle.split('\n');

  const targetMarker = stepId ? `id: ${stepId}` : '### step';
  const startIndex = lines.findIndex(l => l.includes(targetMarker));

  if (startIndex === -1) {
    return `Flow context:\n${flowArticle.slice(0, 600)}`;
  }

  const stepBlock = lines.slice(
    stepId ? Math.max(0, startIndex - 1) : startIndex,
    startIndex + 12
  ).join('\n');

  return `You are guiding the user through a flow. Current step:\n${stepBlock}\nWhen this step is complete, output STEP_COMPLETE on its own line.`;
}

async function handleGetFlow(slug: string, env: Env): Promise<Response> {
  const article = await env.KB_FLOWS.get(slug);
  if (!article) {
    return jsonResponse({ error: `Flow not found: ${slug}` }, 404);
  }
  return new Response(article, {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'text/plain' },
  });
}

async function handleGetFlows(env: Env): Promise<Response> {
  const indexJson = await env.KB_FLOWS.get('__index__');
  return new Response(indexJson ?? '{"flows":[]}', {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}

async function handleTranscribeToken(env: Env): Promise<Response> {
  const response = await fetch(
    'https://streaming.assemblyai.com/v3/token?expires_in_seconds=480',
    { method: 'GET', headers: { authorization: env.ASSEMBLYAI_API_KEY } }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[/transcribe-token] AssemblyAI error ${response.status}: ${errorText}`);
    return new Response(errorText, {
      status: response.status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  const data = await response.text();
  return new Response(data, {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[/tts] ElevenLabs error ${response.status}: ${errorText}`);
    return new Response(errorText, {
      status: response.status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': response.headers.get('content-type') ?? 'audio/mpeg',
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
