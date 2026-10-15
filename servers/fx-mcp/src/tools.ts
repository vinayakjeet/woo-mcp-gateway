import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { FxError, formatAge, type Frankfurter } from './frankfurter.js';

const code = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe('ISO 4217 code, for example USD');
const ok = (text: string, data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  structuredContent: data,
});

const CACHED_FALLBACK =
  'If the rate provider is unreachable, it answers from the last cached rates and says how old they are.';

// The age is always stated, so a caller never mistakes old rates for current ones.
function staleNote(stale: boolean, ageSeconds: number | null, what: string): string {
  return stale
    ? `Cached ${what}, fetched ${formatAge(ageSeconds ?? 0)} ago (Frankfurter is unreachable): `
    : '';
}

function guard<A>(fn: (a: A) => Promise<ReturnType<typeof ok>>) {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      const [c, m] =
        e instanceof FxError
          ? [e.code, e.message]
          : ['internal_error', 'fx-mcp failed to handle the call'];
      return { content: [{ type: 'text' as const, text: `${c}: ${m}` }], isError: true };
    }
  };
}

export function buildFxServer(deps: { fx: Frankfurter }): () => McpServer {
  const { fx } = deps;
  return () => {
    const server = new McpServer({ name: 'fx-mcp', version: '0.1.0' });

    server.registerTool(
      'get_info',
      {
        description: 'Rate provider, supported base currencies and cache age in seconds.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      guard(async () => {
        const c = await fx.currencies();
        const base_currencies = Object.keys(c.value).sort();
        const data = {
          provider: 'Frankfurter',
          base_currencies,
          cache_age_seconds: c.ageSeconds,
          stale: c.stale,
        };
        const note = staleNote(c.stale, c.ageSeconds, 'currency list');
        return ok(`${note}Frankfurter, ${base_currencies.length} currencies`, data);
      }),
    );

    server.registerTool(
      'convert_currency',
      {
        description: `Convert an amount between currencies at the latest or a given date's reference rate. ${CACHED_FALLBACK}`,
        inputSchema: z.object({
          amount: z.number().positive(),
          from: code,
          to: code,
          date: z.iso.date().optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { amount: number; from: string; to: string; date?: string }) => {
        // Frankfurter rejects from == to, and the answer is known anyway.
        const r =
          a.from === a.to
            ? { rate: 1, date: a.date ?? null, stale: false, ageSeconds: null }
            : await (async () => {
                const x = await fx.rates(a.from, [a.to], a.date);
                const rate = x.value.rates[a.to];
                if (rate === undefined)
                  throw new FxError('fx_unknown_currency', `No rate for ${a.to}`);
                return { rate, date: x.value.date, stale: x.stale, ageSeconds: x.ageSeconds };
              })();
        const result = Math.round(a.amount * r.rate * 100) / 100;
        const data = {
          amount: a.amount,
          from: a.from,
          to: a.to,
          rate: r.rate,
          result,
          date: r.date,
          stale: r.stale,
          cache_age_seconds: r.ageSeconds,
        };
        const note = staleNote(r.stale, r.ageSeconds, `rates from ${r.date}`);
        return ok(`${note}${a.amount} ${a.from} = ${result} ${a.to}`, data);
      }),
    );

    server.registerTool(
      'get_rates',
      {
        description: `Latest reference rates for a base currency. ${CACHED_FALLBACK}`,
        inputSchema: z.object({ base: code, symbols: z.array(code).min(1).max(30).optional() }),
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { base: string; symbols?: string[] }) => {
        const { value: x, stale, ageSeconds } = await fx.rates(a.base, a.symbols);
        const note = staleNote(stale, ageSeconds, `rates from ${x.date}`);
        const text = `${note}${Object.keys(x.rates).length} rates for ${x.base} on ${x.date}`;
        return ok(text, { ...x, stale, cache_age_seconds: ageSeconds });
      }),
    );

    return server;
  };
}
