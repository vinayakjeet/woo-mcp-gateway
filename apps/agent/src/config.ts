export type Provider = {
  name: 'primary' | 'fallback';
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type AgentConfig = {
  port: number;
  appOrigin: string;
  controlPlaneUrl: string;
  internalSecret: string;
  gatewayMcpUrl: string;
  primary: Provider;
  fallback: Provider | null;
  reasoningEffort: string | null;
};

const REQUIRED = [
  'APP_ORIGIN',
  'CONTROL_PLANE_INTERNAL_URL',
  'INTERNAL_SECRET',
  'GATEWAY_MCP_URL',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
] as const;

// Provider docs give base URLs with a trailing slash; requests append /chat/completions.
const trimSlash = (url: string) => url.replace(/\/+$/, '');

// Chat agent: `auto` adds nothing, so the gateway decides from the visible tool count.
function gatewayUrl(base: string, mode: string | undefined): string {
  if (mode === undefined || mode === '' || mode === 'auto') return base;
  if (mode !== 'search' && mode !== 'full') {
    throw new Error('AGENT_TOOL_MODE must be auto, search or full');
  }
  const url = new URL(base);
  url.searchParams.set('toolMode', mode);
  return url.href;
}

export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const missing = REQUIRED.filter((n) => !env[n]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  const get = (n: (typeof REQUIRED)[number]) => env[n]!;
  const [fbUrl, fbModel, fbKey] = [
    env.LLM_FALLBACK_BASE_URL,
    env.LLM_FALLBACK_MODEL,
    env.LLM_FALLBACK_API_KEY,
  ];
  return {
    port: Number(env.PORT ?? 3100),
    appOrigin: get('APP_ORIGIN'),
    controlPlaneUrl: trimSlash(get('CONTROL_PLANE_INTERNAL_URL')),
    internalSecret: get('INTERNAL_SECRET'),
    gatewayMcpUrl: gatewayUrl(get('GATEWAY_MCP_URL'), env.AGENT_TOOL_MODE),
    primary: {
      name: 'primary',
      baseUrl: trimSlash(get('LLM_BASE_URL')),
      model: get('LLM_MODEL'),
      apiKey: get('LLM_API_KEY'),
    },
    // The chart marks the fallback key optional, so a Secret without it turns the fallback off.
    fallback:
      fbUrl && fbModel && fbKey
        ? { name: 'fallback', baseUrl: trimSlash(fbUrl), model: fbModel, apiKey: fbKey }
        : null,
    reasoningEffort: env.LLM_REASONING_EFFORT || null,
  };
}
