import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type Resolver = (host: string) => Promise<string[]>;
export type UpstreamUrlOptions = { allowInsecure: boolean; resolve?: Resolver };

export const resolveAll: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// Names that only mean something inside the cluster or on the host, whatever they resolve to.
const BLOCKED_SUFFIXES = ['.localhost', '.svc', '.cluster.local', '.internal', '.local'];

// Only plain public unicast addresses pass. ipaddr.js names the other ranges (loopback, private,
// link-local, carrier-grade NAT, multicast, reserved, 6to4, Teredo, ...) so none is listed here.
// process() turns ::ffff:a.b.c.d into the IPv4 address it wraps.
export function isAllowedAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  return ipaddr.process(ip).range() === 'unicast';
}

function bareHost(hostname: string): string {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

// Returns the reason an admin-supplied upstream URL is refused, or null. The WHATWG parser has
// already turned decimal, octal and hex IPv4 forms into dotted quads by the time we look at the host.
export async function checkUpstreamUrl(
  raw: string,
  opts: UpstreamUrlOptions,
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && !(opts.allowInsecure && u.protocol === 'http:')) {
    return opts.allowInsecure ? 'scheme must be http or https' : 'scheme must be https';
  }
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  const host = bareHost(u.hostname);
  if (!host) return 'missing host';

  if (ipaddr.isValid(host)) {
    return isAllowedAddress(host) ? null : 'address is not a public address';
  }
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'host name is internal';
  }
  // A single label resolves through the pod's search domains to a cluster service.
  if (!host.includes('.')) return 'host name has no domain';

  let addrs: string[];
  try {
    addrs = await (opts.resolve ?? resolveAll)(host);
  } catch {
    return 'host name does not resolve';
  }
  if (addrs.length === 0) return 'host name does not resolve';
  // One private answer among public ones is enough to refuse: the client may pick any of them.
  if (!addrs.every(isAllowedAddress)) return 'host resolves to a non-public address';
  return null;
}
