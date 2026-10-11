import { schema } from '@woo/core/db';
import type { AuditRow, AuditSink, Db } from './types.js';

export class PgAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}

  async write(row: AuditRow): Promise<void> {
    await this.db.insert(schema.auditEvents).values(row);
  }
}
