import { describe, expect, it } from 'vitest';
import { hostedPill, hostedPollMs, HOSTED_POLL_MS, toHostedBody, type HostedForm } from './hosted';

const form = (over: Partial<HostedForm> = {}): HostedForm => ({
  slug: 'fx2',
  image: 'fx-mcp:dev',
  port: '8080',
  path: '/mcp',
  env: [],
  secretEnv: [],
  cpu: '200m',
  memory: '128Mi',
  ...over,
});

describe('toHostedBody', () => {
  it('drops empty env rows and keeps order', () => {
    const body = toHostedBody(
      form({
        env: [
          { name: 'B', value: '2' },
          { name: '', value: '' },
          { name: '  ', value: 'x' },
          { name: 'A', value: '1' },
        ],
        secretEnv: [
          { name: '', value: '' },
          { name: 'TOKEN', value: 's3' },
          { name: 'KEY', value: 's4' },
        ],
      }),
    );
    expect(body.env).toEqual([
      { name: 'B', value: '2' },
      { name: 'A', value: '1' },
    ]);
    expect(body.secretEnv).toEqual([
      { name: 'TOKEN', value: 's3' },
      { name: 'KEY', value: 's4' },
    ]);
  });

  it('turns the port into a number and trims text fields', () => {
    expect(toHostedBody(form({ slug: ' fx2 ', image: ' fx-mcp:dev ', port: '9000' }))).toEqual({
      slug: 'fx2',
      image: 'fx-mcp:dev',
      port: 9000,
      path: '/mcp',
      env: [],
      secretEnv: [],
      cpu: '200m',
      memory: '128Mi',
    });
  });

  it('keeps a bad port as NaN-free input for the server to refuse', () => {
    expect(toHostedBody(form({ port: 'abc' })).port).toBe(0);
  });
});

describe('hostedPill', () => {
  it('maps every status to a label and tone', () => {
    expect(hostedPill('pending')).toEqual({ label: 'Pending', tone: 'warn' });
    expect(hostedPill('ready')).toEqual({ label: 'Ready', tone: 'ok' });
    expect(hostedPill('failed')).toEqual({ label: 'Failed', tone: 'bad' });
    expect(hostedPill('deleting')).toEqual({ label: 'Deleting', tone: 'off' });
  });
});

describe('hostedPollMs', () => {
  it('polls every 3 s while a row is pending or deleting and stops otherwise', () => {
    expect(HOSTED_POLL_MS).toBe(3000);
    expect(hostedPollMs([{ status: 'ready' }, { status: 'pending' }])).toBe(3000);
    expect(hostedPollMs([{ status: 'deleting' }])).toBe(3000);
    expect(hostedPollMs([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
    expect(hostedPollMs([])).toBe(false);
    expect(hostedPollMs(undefined)).toBe(false);
  });
});
