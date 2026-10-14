import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/client';
import { checkUpstreamUrl, isAllowedAddress, resolveAll, type Resolver } from '@woo/core';
import { Agent, fetch as undiciFetch } from 'undici';
import { BLOCKED_CODE } from './classify.js';

export type PinnedFetchOptions = {
  allowInsecure: boolean;
  resolve?: Resolver;
  // Tests only: the default is the same address rule the control-plane applies.
  isAllowed?: (ip: string) => boolean;
};

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;
export type Lookup = (host: string, options: { all?: boolean }, cb: LookupCallback) => void;

class BlockedError extends Error {
  readonly code = BLOCKED_CODE;
}

// The socket connects to an address this function returned, so a name that turned private after
// the admin added the server (DNS rebinding) is refused at the moment of connecting. Node asks
// for one address or for all of them (happy eyeballs), so both shapes are answered.
export function checkedLookup(o: Pick<PinnedFetchOptions, 'resolve' | 'isAllowed'>): Lookup {
  const resolve = o.resolve ?? resolveAll;
  const isAllowed = o.isAllowed ?? isAllowedAddress;
  return (host, options, cb) => {
    resolve(host).then(
      (addrs) => {
        if (addrs.length === 0) {
          cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
        } else if (!addrs.every(isAllowed)) {
          cb(new BlockedError('upstream address is not public'));
        } else {
          const list = addrs.map((address) => ({ address, family: isIP(address) }));
          if (options.all) cb(null, list);
          else cb(null, list[0]!.address, list[0]!.family);
        }
      },
      (err: unknown) => cb(err as NodeJS.ErrnoException),
    );
  };
}

// For external upstreams only. undici's own fetch is used because Node's bundled fetch does not
// take a dispatcher from the package. Redirects are errors: a 3xx must never move the gateway
// (and its stored credential) to another host.
export function pinnedFetch(o: PinnedFetchOptions): FetchLike {
  const agent = new Agent({ connect: { lookup: checkedLookup(o) } as never });
  return async (url, init) => {
    // Names are resolved at connect time. This pass covers what a lookup never sees: the scheme,
    // IP literals and cluster-internal names. The resolver stub is never asked for a real answer.
    const reason = await checkUpstreamUrl(String(url), {
      allowInsecure: o.allowInsecure,
      resolve: async () => ['1.1.1.1'],
    });
    if (reason) throw new BlockedError(reason);
    const res = await undiciFetch(url, {
      ...init,
      redirect: 'error',
      dispatcher: agent,
    } as never);
    return res as unknown as Response;
  };
}
