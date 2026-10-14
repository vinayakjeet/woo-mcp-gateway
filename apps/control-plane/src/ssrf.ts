import { checkUpstreamUrl, type Resolver } from '@woo/core';

// A non-null result is the reason for refusing the URL.
export type UrlCheck = (url: string) => Promise<string | null>;

export const urlCheck =
  (allowInsecure: boolean, resolve?: Resolver): UrlCheck =>
  (url) =>
    checkUpstreamUrl(url, { allowInsecure, ...(resolve ? { resolve } : {}) });

// Anything but the exact string "true" keeps https-only, so a typo in the chart fails closed.
export const urlCheckFromEnv = (env: NodeJS.ProcessEnv): UrlCheck =>
  urlCheck(env.ALLOW_INSECURE_UPSTREAMS === 'true');
