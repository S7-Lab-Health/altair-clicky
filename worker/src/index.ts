/**
 * Clicky Proxy Worker
 *
 * Routes:
 *   POST /chat              → Azure AI Foundry (intent classify → flow inject → stream)
 *   GET  /flow/:slug        → Fetch a flow article from KB_FLOWS KV
 *   GET  /flows             → List all flow slugs + aliases
 *   POST /tts               → ElevenLabs TTS API
 *   POST /transcribe-token  → AssemblyAI ephemeral token
 */

export interface Env {
  AZURE_FOUNDRY_ENDPOINT: string;
  AZURE_FOUNDRY_KEY: string;
  FOUNDRY_FAST_MODEL: string;
  FOUNDRY_MAIN_MODEL: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  KB_FLOWS: KVNamespace;
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

interface FlowIndex {
  flows: FlowIndexEntry[];
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CLICKY_SYSTEM_PROMPT = `You are Clicky, an onboarding guide built into Altair, a medical billing platform.
You help billing staff navigate the app through step-by-step guidance.
Rules:
- Be concise and friendly. One or two sentences per step maximum.
- When you reference a UI element the user should interact with, append [ANCHOR:anchor-name] immediately after mentioning it.
  Example: "Click Upload Batch [ANCHOR:upload-batch-button] in the top right corner."
- When a guided flow step is complete, output STEP_COMPLETE on its own line.
- Never use markdown formatting — your responses are spoken aloud via text-to-speech.
- If asked an off-topic question mid-flow, answer it briefly, then resume the flow.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

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

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body: ChatRequestBody = await request.json();
  const { messages, url, domExcerpt, stepId } = body;
  let { flowSlug } = body;

  // If no flowSlug, classify intent to see if the user is asking for a guided flow
  if (!flowSlug) {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    flowSlug = (await classifyIntent(lastUserMessage, env)) ?? undefined;
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
    `${env.AZURE_FOUNDRY_ENDPOINT}/models/chat/completions?api-version=2025-01-01-preview`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.AZURE_FOUNDRY_KEY,
      },
      body: JSON.stringify({
        model: env.FOUNDRY_MAIN_MODEL,
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
      // Return the resolved slug so the extension knows which flow was matched
      'x-clicky-flow-slug': flowSlug ?? '',
    },
  });
}

// Calls the fast Foundry deployment to classify user intent against the flow index.
// Returns the matching flow slug, or null if no flow matches.
async function classifyIntent(userMessage: string, env: Env): Promise<string | null> {
  const indexJson = await env.KB_FLOWS.get('__index__');
  if (!indexJson) return null;

  const index: FlowIndex = JSON.parse(indexJson);
  const flowList = index.flows
    .map(f => `${f.slug}: ${f.aliases.join(', ')}`)
    .join('\n');

  const response = await fetch(
    `${env.AZURE_FOUNDRY_ENDPOINT}/models/chat/completions?api-version=2025-01-01-preview`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.AZURE_FOUNDRY_KEY,
      },
      body: JSON.stringify({
        model: env.FOUNDRY_FAST_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are an intent classifier for a medical billing app onboarding guide.
Given a user message and a list of available guided flows (slug: aliases), return ONLY the matching slug if the user is asking to be guided through a specific task.
Return null if no flow matches or the user is asking a general question.
Respond with JSON only: {"flowSlug": "the-slug"} or {"flowSlug": null}`,
          },
          {
            role: 'user',
            content: `Available flows:\n${flowList}\n\nUser message: "${userMessage}"`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    }
  );

  if (!response.ok) return null;

  try {
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(data.choices[0].message.content) as { flowSlug: string | null };
    return parsed.flowSlug ?? null;
  } catch {
    return null;
  }
}

// Extracts the context for the current step from a flow article to inject into the system prompt.
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
