import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Router } from './registry.js';
import type { AuditSink, Principal } from './types.js';

export type GatewayAppOptions = {
  router: Router;
  audit: AuditSink;
  authenticate(header: string | undefined): Promise<Principal | null>;
  replica: string;
  allowedOrigins: string[];
  logger?: FastifyServerOptions['logger'];
};

// Stub so the skipped isolation test compiles and loads. Task 7 replaces this file.
export function buildGatewayApp(o: GatewayAppOptions): FastifyInstance {
  throw new Error(`buildGatewayApp is not implemented yet (${o.replica})`);
}
