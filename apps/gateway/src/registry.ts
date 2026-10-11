import type { Tool } from '@modelcontextprotocol/client';
import type { Log, ServerRecord } from './types.js';

// Stub so the skipped isolation test compiles and loads. Task 5 replaces this file.
export interface Router {
  list(): Tool[];
}

export class Registry implements Router {
  constructor(readonly o: { log: Log }) {}

  apply(record: ServerRecord): void {
    throw new Error(`Registry.apply is not implemented yet (${record.slug})`);
  }

  list(): Tool[] {
    throw new Error('Registry.list is not implemented yet');
  }

  async close(): Promise<void> {}
}
