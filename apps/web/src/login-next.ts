const PREFIX = '/oauth/authorize?';
const MAX_LENGTH = 4000;

// The control-plane sends a signed-out OAuth authorize request to /login?next=<path>. That one
// path is followed after login, and nothing else: the control-plane serves it, not this app, so it
// needs a full navigation, and a looser rule would make /login an open redirect.
export function oauthNext(next: string | null): string | null {
  if (next === null || next.length > MAX_LENGTH || !next.startsWith(PREFIX)) return null;
  return next;
}
