import { checkUpstreamUrl, parseDenyAddresses, type DenyList, type Resolver } from '@woo/core';

// A non-null result is the reason for refusing the URL.
export type UrlCheck = (url: string) => Promise<string | null>;

export const urlCheck =
  (allowInsecure: boolean, resolve?: Resolver, deny?: DenyList): UrlCheck =>
  (url) =>
    checkUpstreamUrl(url, {
      allowInsecure,
      ...(resolve ? { resolve } : {}),
      ...(deny ? { deny } : {}),
    });

// Anything but the exact string "true" keeps https-only, so a typo in the chart fails closed.
export const urlCheckFromEnv = (env: NodeJS.ProcessEnv): UrlCheck =>
  urlCheck(
    env.ALLOW_INSECURE_UPSTREAMS === 'true',
    undefined,
    parseDenyAddresses(env.UPSTREAM_DENY_ADDRESSES),
  );
