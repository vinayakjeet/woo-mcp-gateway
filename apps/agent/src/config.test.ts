import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const env = {
  APP_ORIGIN: 'http://app.127.0.0.1.nip.io',
  CONTROL_PLANE_INTERNAL_URL: 'http://control-plane-internal.platform.svc.cluster.local:3001/',
  INTERNAL_SECRET: 'internal-secret',
  GATEWAY_MCP_URL: 'http://gateway.platform.svc.cluster.local:8080/mcp',
  LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  LLM_MODEL: 'gemini-3.8-flash',
  LLM_API_KEY: 'primary-key',
};
const fallbackEnv = {
  LLM_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1',
  LLM_FALLBACK_MODEL: 'openai/gpt-oss-120b',
  LLM_FALLBACK_API_KEY: 'fallback-key',
};

describe('loadConfig', () => {
  it('reads the primary provider, trims trailing slashes and defaults the port', () => {
    const c = loadConfig(env);
    expect(c.port).toBe(3100);
    expect(c.controlPlaneUrl).toBe('http://control-plane-internal.platform.svc.cluster.local:3001');
    expect(c.gatewayMcpUrl).toBe('http://gateway.platform.svc.cluster.local:8080/mcp');
    expect(c.primary).toEqual({
      name: 'primary',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-flash',
      apiKey: 'primary-key',
    });
    expect(c.fallback).toBeNull();
    expect(c.reasoningEffort).toBeNull();
  });

  it('names the missing variables', () => {
    expect(() => loadConfig({ ...env, LLM_API_KEY: '', INTERNAL_SECRET: undefined })).toThrow(
      'Missing env vars: INTERNAL_SECRET, LLM_API_KEY',
    );
  });

  it('turns the fallback on only with a url, a model and a key', () => {
    expect(loadConfig({ ...env, ...fallbackEnv }).fallback).toEqual({
      name: 'fallback',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      apiKey: 'fallback-key',
    });
    expect(loadConfig({ ...env, ...fallbackEnv, LLM_FALLBACK_API_KEY: '' }).fallback).toBeNull();
    expect(
      loadConfig({ ...env, ...fallbackEnv, LLM_FALLBACK_MODEL: undefined }).fallback,
    ).toBeNull();
  });

  it('reads PORT and the reasoning effort', () => {
    const c = loadConfig({ ...env, PORT: '3999', LLM_REASONING_EFFORT: 'low' });
    expect([c.port, c.reasoningEffort]).toEqual([3999, 'low']);
  });

  describe('AGENT_TOOL_MODE', () => {
    it.each(['search', 'full'])('appends ?toolMode=%s to the gateway URL', (mode) => {
      expect(loadConfig({ ...env, AGENT_TOOL_MODE: mode }).gatewayMcpUrl).toBe(
        `http://gateway.platform.svc.cluster.local:8080/mcp?toolMode=${mode}`,
      );
    });

    it.each([undefined, '', 'auto'])('leaves the URL unchanged for %j', (mode) => {
      expect(loadConfig({ ...env, AGENT_TOOL_MODE: mode }).gatewayMcpUrl).toBe(env.GATEWAY_MCP_URL);
    });

    it.each(['bogus', 'SEARCH', 'search '])('fails at start for %j', (mode) => {
      expect(() => loadConfig({ ...env, AGENT_TOOL_MODE: mode })).toThrow(
        'AGENT_TOOL_MODE must be auto, search or full',
      );
    });
  });
});
