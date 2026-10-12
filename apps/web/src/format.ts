// Audit timestamps carry microseconds; Date parsing is only specified for milliseconds.
function toDate(ts: string): Date {
  return new Date(ts.replace(/(\.\d{3})\d+Z$/, '$1Z'));
}

export function formatTs(ts: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(toDate(ts));
}

export function ago(ts: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - toDate(ts).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
