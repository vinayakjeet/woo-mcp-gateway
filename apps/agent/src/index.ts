import { installGracefulShutdown, LOG_REDACT } from '@woo/core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectGateway } from './gateway.js';
import { introspect } from './introspect.js';
import { ChatModel } from './model.js';

const cfg = loadConfig(process.env);
const app = buildApp(
  {
    appOrigin: cfg.appOrigin,
    introspect: (cookie) =>
      introspect({ baseUrl: cfg.controlPlaneUrl, secret: cfg.internalSecret, cookie }),
    connect: (token, traceparent) => connectGateway(cfg.gatewayMcpUrl, token, traceparent),
    // A new model per turn: the switch to the fallback lasts for that turn only.
    model: () =>
      new ChatModel({
        primary: cfg.primary,
        fallback: cfg.fallback,
        reasoningEffort: cfg.reasoningEffort,
      }),
  },
  { redact: LOG_REDACT },
);

await app.listen({ host: '0.0.0.0', port: cfg.port });
app.log.info(
  { primary: cfg.primary.model, fallback: cfg.fallback?.model ?? null },
  'llm providers',
);

installGracefulShutdown({ servers: [app.server], close: () => app.close() });
