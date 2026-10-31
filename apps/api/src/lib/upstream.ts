// O5 provider stack — OpenAI-compatible upstreams for the TEXT tier.
// Three of the four text providers (groq, mistral, openrouter) speak
// OpenAI natively; Gemini exposes an OpenAI-compatible surface, so one
// passthrough adapter covers the whole text tier.
const BASE: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/v1',
};

export const TEXT_PROVIDERS = Object.keys(BASE);

// JATIN_UPSTREAM_BASE overrides every provider (tests point it at a local
// fake upstream — the gateway code under test is the real one).
export function upstreamBase(provider: string): string {
  if (process.env.JATIN_UPSTREAM_BASE) return process.env.JATIN_UPSTREAM_BASE;
  return BASE[provider] ?? '';
}

// Service tier — web search + image, the other two faces one gateway key
// can call (text · search · image). The customer sees "search" and "image"
// — never these names.
const SERVICE_BASE: Record<string, string> = {
  tavily: 'https://api.tavily.com',
  serper: 'https://google.serper.dev',
  pollinations: 'https://image.pollinations.ai',
};

export const SEARCH_PROVIDERS = ['tavily', 'serper'] as const;
export const IMAGE_PROVIDERS = ['pollinations'] as const;

export function serviceBase(provider: string): string {
  if (process.env.JATIN_UPSTREAM_BASE) return process.env.JATIN_UPSTREAM_BASE;
  return SERVICE_BASE[provider] ?? '';
}
