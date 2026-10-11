export type DatePreset = 'today' | 'yesterday' | 'last_7_days';

export function storeTimeZone(index: {
  timezone_string?: string;
  gmt_offset?: number | string;
}): string {
  if (index.timezone_string) return index.timezone_string;
  const minutes = Math.round(Number(index.gmt_offset ?? 0) * 60);
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function wallClock(timeZone: string, d: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

function offsetMs(timeZone: string, d: Date): number {
  const w = wallClock(timeZone, d);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(d.getTime() / 1000) * 1000;
}

// Two passes because the offset at local midnight can differ from the offset at the first guess (DST days).
export function startOfDay(timeZone: string, now: Date, daysBack: number): Date {
  const w = wallClock(timeZone, now);
  const wall = Date.UTC(w.y, w.m - 1, w.d - daysBack);
  const first = wall - offsetMs(timeZone, new Date(wall));
  return new Date(wall - offsetMs(timeZone, new Date(first)));
}

export function resolveRange(
  input: { date?: DatePreset; after?: string; before?: string },
  timeZone: string,
  now: Date,
): { after?: Date; before?: Date } {
  if (input.date && (input.after || input.before)) {
    throw new RangeError('Use either date or after/before, not both');
  }
  switch (input.date) {
    case 'today':
      return { after: startOfDay(timeZone, now, 0), before: now };
    case 'yesterday':
      return { after: startOfDay(timeZone, now, 1), before: startOfDay(timeZone, now, 0) };
    case 'last_7_days':
      return { after: startOfDay(timeZone, now, 6), before: now };
  }
  const range: { after?: Date; before?: Date } = {};
  if (input.after) range.after = new Date(input.after);
  if (input.before) range.before = new Date(input.before);
  if (range.after && range.before && range.after > range.before) {
    throw new RangeError('after must be earlier than before');
  }
  return range;
}

export function toWcGmt(d: Date): string {
  return d.toISOString().slice(0, 19);
}
