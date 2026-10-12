export type UrlCheck = (url: string) => Promise<string | null>;

// M10 replaces this with the SPEC 22 validator (resolved addresses, private ranges). Until then
// only the scheme and length rules in server-input.ts apply. A non-null result is the reason
// for refusing the URL.
export const checkUpstreamUrl: UrlCheck = async () => null;
