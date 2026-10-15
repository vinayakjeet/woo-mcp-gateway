// Prometheus text exposition (format 0.0.4), written by hand so the services need no metrics library.
// Label values are the caller's job to keep bounded: never pass client text. maxSeries is a backstop.

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_MAX_SERIES = 1000;

type Labels = Record<string, string>;
export type GaugeSample = { labels: Labels; value: number };

const escapeHelp = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeValue = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function num(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return '+Inf';
  if (n === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(n);
}

function checkLabelNames(names: readonly string[], reserved: readonly string[] = []): void {
  for (const n of names) {
    if (!LABEL_NAME.test(n) || n.startsWith('__') || reserved.includes(n))
      throw new Error(`invalid label name: ${n}`);
  }
}

function formatLabels(names: readonly string[], values: readonly string[], extra = ''): string {
  const parts = names.map((n, i) => `${n}="${escapeValue(values[i] ?? '')}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

// The label values in declared order. Unknown and missing labels throw: a typo should fail a test,
// not create a second series.
function valuesOf(names: readonly string[], labels: Labels): string[] {
  const given = Object.keys(labels);
  if (given.length !== names.length || given.some((k) => !names.includes(k)))
    throw new Error('labels do not match the declared label names');
  return names.map((n) => labels[n] as string);
}

const seriesKey = (values: readonly string[]) => values.join('\u0000');

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    protected readonly labelNames: readonly string[],
  ) {}
  protected header(type: string): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${type}`];
  }
  abstract lines(): string[];
}

class Counter extends Metric {
  private readonly series = new Map<string, { values: string[]; n: number }>();
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    private readonly maxSeries: number,
  ) {
    super(name, help, labelNames);
  }
  inc(labels: Labels = {}, by = 1): void {
    const values = valuesOf(this.labelNames, labels);
    const key = seriesKey(values);
    const s = this.series.get(key);
    if (s) s.n += by;
    else if (this.series.size < this.maxSeries) this.series.set(key, { values, n: by });
  }
  lines(): string[] {
    return [
      ...this.header('counter'),
      ...[...this.series.values()].map(
        (s) => `${this.name}${formatLabels(this.labelNames, s.values)} ${num(s.n)}`,
      ),
    ];
  }
}

class Histogram extends Metric {
  private readonly series = new Map<
    string,
    { values: string[]; counts: number[]; sum: number; count: number }
  >();
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    private readonly buckets: readonly number[],
    private readonly maxSeries: number,
  ) {
    super(name, help, labelNames);
  }
  observe(labels: Labels, value: number): void {
    const values = valuesOf(this.labelNames, labels);
    const key = seriesKey(values);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= this.maxSeries) return;
      s = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((le, i) => {
      if (value <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count += 1;
  }
  lines(): string[] {
    const out = this.header('histogram');
    for (const s of this.series.values()) {
      this.buckets.forEach((le, i) =>
        out.push(
          `${this.name}_bucket${formatLabels(this.labelNames, s.values, `le="${num(le)}"`)} ${s.counts[i] ?? 0}`,
        ),
      );
      out.push(
        `${this.name}_bucket${formatLabels(this.labelNames, s.values, 'le="+Inf"')} ${s.count}`,
        `${this.name}_sum${formatLabels(this.labelNames, s.values)} ${num(s.sum)}`,
        `${this.name}_count${formatLabels(this.labelNames, s.values)} ${s.count}`,
      );
    }
    return out;
  }
}

class Gauge extends Metric {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    private readonly collect: () => GaugeSample[],
  ) {
    super(name, help, labelNames);
  }
  lines(): string[] {
    let samples: GaugeSample[] = [];
    try {
      samples = this.collect();
    } catch {
      // A collector error can carry SQL or paths, so it is neither printed nor logged here.
      // The family stays, empty, and the scrape still succeeds.
    }
    return [
      ...this.header('gauge'),
      ...samples.flatMap((s) => {
        try {
          return [
            `${this.name}${formatLabels(this.labelNames, valuesOf(this.labelNames, s.labels))} ${num(s.value)}`,
          ];
        } catch {
          return [];
        }
      }),
    ];
  }
}

export type { Counter, Histogram };

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly maxSeries: number;

  constructor(o: { maxSeries?: number } = {}) {
    this.maxSeries = o.maxSeries ?? DEFAULT_MAX_SERIES;
  }

  private add<T extends Metric>(name: string, metric: T): T {
    this.metrics.set(name, metric);
    return metric;
  }

  private declare(name: string, labelNames: readonly string[], reserved: readonly string[] = []) {
    if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
    if (this.metrics.has(name)) throw new Error(`metric already registered: ${name}`);
    checkLabelNames(labelNames, reserved);
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    this.declare(name, labelNames);
    return this.add(name, new Counter(name, help, labelNames, this.maxSeries));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram {
    this.declare(name, labelNames, ['le']);
    if (buckets.length === 0 || buckets.some((b, i) => i > 0 && b <= (buckets[i - 1] as number)))
      throw new Error('histogram buckets must be strictly increasing');
    return this.add(name, new Histogram(name, help, labelNames, buckets, this.maxSeries));
  }

  // Read at scrape time, so the value is the state now and never a stale copy.
  gauge(
    name: string,
    help: string,
    labelNames: readonly string[],
    collect: () => GaugeSample[],
  ): void {
    this.declare(name, labelNames);
    this.add(name, new Gauge(name, help, labelNames, collect));
  }

  render(): string {
    return [...this.metrics.values()].flatMap((m) => m.lines()).join('\n') + '\n';
  }
}
