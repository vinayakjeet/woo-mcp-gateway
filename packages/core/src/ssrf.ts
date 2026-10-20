import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type Resolver = (host: string) => Promise<string[]>;
// Parsed CIDRs from UPSTREAM_DENY_ADDRESSES: public addresses that are still off limits.
export type DenyList = ReadonlyArray<[ipaddr.IPv4 | ipaddr.IPv6, number]>;
export type UpstreamUrlOptions = { allowInsecure: boolean; resolve?: Resolver; deny?: DenyList };

export const resolveAll: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// Names that only mean something inside the cluster or on the host, whatever they resolve to.
const BLOCKED_SUFFIXES = ['.localhost', '.svc', '.cluster.local', '.internal', '.local'];

// Only plain public unicast addresses pass. ipaddr.js names the other ranges (loopback, private,
// link-local, carrier-grade NAT, multicast, reserved, 6to4, Teredo, ...) so none is listed here.
// process() turns ::ffff:a.b.c.d into the IPv4 address it wraps.
export function isAllowedAddress(ip: string, deny: DenyList = []): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const addr = ipaddr.process(ip);
  if (addr.range() !== 'unicast') return false;
  return !deny.some(([net, bits]) => addr.kind() === net.kind() && addr.match(net, bits));
}

// The VM's own public address is plain unicast, so the range check above lets it through and
// only an explicit list can refuse it. Entries are CIDRs or bare addresses, separated by commas.
// A bad entry throws at startup: a typo must not leave the list empty. The error names the
// variable and the entry's position, never the entry.
export function parseDenyAddresses(raw: string | undefined): DenyList {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.map((entry, i) => {
    try {
      if (!entry.includes('/')) {
        const a = ipaddr.parse(entry);
        return [a, a.kind() === 'ipv4' ? 32 : 128] as [ipaddr.IPv4 | ipaddr.IPv6, number];
      }
      return ipaddr.parseCIDR(entry);
    } catch {
      throw new Error(`UPSTREAM_DENY_ADDRESSES entry ${i + 1} is not an address or a CIDR`);
    }
  });
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
    return isAllowedAddress(host, opts.deny) ? null : 'address is not a public address';
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
  if (!addrs.every((a) => isAllowedAddress(a, opts.deny)))
    return 'host resolves to a non-public address';
  return null;
}
