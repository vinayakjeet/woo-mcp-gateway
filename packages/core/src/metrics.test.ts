import { describe, expect, it } from 'vitest';
import { MetricsRegistry, METRICS_CONTENT_TYPE } from './metrics.js';

describe('MetricsRegistry', () => {
  it('prints a counter with HELP, TYPE and one line per label set', () => {
    const r = new MetricsRegistry();
    const c = r.counter('calls_total', 'Calls.', ['server', 'outcome']);
    c.inc({ server: 'main', outcome: 'ok' });
    c.inc({ server: 'main', outcome: 'ok' }, 2);
    c.inc({ server: 'fx', outcome: 'timeout' });
    expect(r.render()).toBe(
      [
        '# HELP calls_total Calls.',
        '# TYPE calls_total counter',
        'calls_total{server="main",outcome="ok"} 3',
        'calls_total{server="fx",outcome="timeout"} 1',
        '',
      ].join('\n'),
    );
  });

  it('prints a counter without labels as a bare name and shows HELP and TYPE with no samples', () => {
    const r = new MetricsRegistry();
    const c = r.counter('plain_total', 'Plain.');
    expect(r.render()).toBe('# HELP plain_total Plain.\n# TYPE plain_total counter\n');
    c.inc();
    expect(r.render()).toContain('\nplain_total 1\n');
  });

  it('escapes backslash, quote and newline in label values and backslash and newline in HELP', () => {
    const r = new MetricsRegistry();
    r.counter('esc_total', 'Line\none\\two', ['v']).inc({ v: 'a"b\\c\nd' });
    const out = r.render();
    expect(out).toContain('# HELP esc_total Line\\none\\\\two\n');
    expect(out).toContain('esc_total{v="a\\"b\\\\c\\nd"} 1\n');
  });

  it('prints a histogram with cumulative buckets, +Inf, _sum and _count', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('dur_seconds', 'Duration.', ['server'], [0.1, 1]);
    h.observe({ server: 'main' }, 0.05);
    h.observe({ server: 'main' }, 0.5);
    h.observe({ server: 'main' }, 5);
    expect(r.render()).toBe(
      [
        '# HELP dur_seconds Duration.',
        '# TYPE dur_seconds histogram',
        'dur_seconds_bucket{server="main",le="0.1"} 1',
        'dur_seconds_bucket{server="main",le="1"} 2',
        'dur_seconds_bucket{server="main",le="+Inf"} 3',
        'dur_seconds_sum{server="main"} 5.55',
        'dur_seconds_count{server="main"} 3',
        '',
      ].join('\n'),
    );
  });

  it('counts a value equal to a bucket bound in that bucket', () => {
    const r = new MetricsRegistry();
    r.histogram('d_seconds', 'D.', [], [1, 2]).observe({}, 1);
    expect(r.render()).toContain('d_seconds_bucket{le="1"} 1\n');
  });

  it('reads a gauge when it renders, so it reflects the state at scrape time', () => {
    const r = new MetricsRegistry();
    let up = 1;
    r.gauge('up', 'Up.', ['server'], () => [{ labels: { server: 'fx' }, value: up }]);
    expect(r.render()).toContain('up{server="fx"} 1\n');
    up = 0;
    expect(r.render()).toContain('up{server="fx"} 0\n');
  });

  it('keeps going when a gauge collector throws, and says nothing about the error', () => {
    const r = new MetricsRegistry();
    r.counter('ok_total', 'Ok.').inc();
    r.gauge('bad', 'Bad.', [], () => {
      throw new Error('select * from secrets');
    });
    const out = r.render();
    expect(out).toContain('ok_total 1');
    expect(out).toContain('# TYPE bad gauge\n');
    expect(out).not.toContain('secrets');
  });

  it('refuses invalid metric names, label names, the reserved le label and unknown or missing labels', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter('bad name', 'x')).toThrow();
    expect(() => r.counter('ok_total', 'x', ['bad-label'])).toThrow();
    expect(() => r.counter('ok2_total', 'x', ['__reserved'])).toThrow();
    expect(() => r.histogram('h_seconds', 'x', ['le'], [1])).toThrow();
    const c = r.counter('c_total', 'x', ['a']);
    expect(() => c.inc({ b: '1' })).toThrow();
    expect(() => c.inc({})).toThrow();
    expect(() => r.counter('c_total', 'again')).toThrow();
  });

  it('refuses buckets that are not strictly increasing', () => {
    const r = new MetricsRegistry();
    expect(() => r.histogram('h_seconds', 'x', [], [1, 1])).toThrow();
    expect(() => r.histogram('h2_seconds', 'x', [], [2, 1])).toThrow();
    expect(() => r.histogram('h3_seconds', 'x', [], [])).toThrow();
  });

  it('stops creating new series past the cap and keeps counting the ones it has', () => {
    const r = new MetricsRegistry({ maxSeries: 2 });
    const c = r.counter('cap_total', 'Cap.', ['k']);
    c.inc({ k: 'a' });
    c.inc({ k: 'b' });
    c.inc({ k: 'c' });
    c.inc({ k: 'a' });
    const out = r.render();
    expect(out).toContain('cap_total{k="a"} 2\n');
    expect(out).toContain('cap_total{k="b"} 1\n');
    expect(out).not.toContain('k="c"');
  });

  it('prints special numbers the way Prometheus reads them', () => {
    const r = new MetricsRegistry();
    r.gauge('g', 'G.', [], () => [{ labels: {}, value: Number.POSITIVE_INFINITY }]);
    expect(r.render()).toContain('\ng +Inf\n');
  });

  it('exports the text exposition content type', () => {
    expect(METRICS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});
