/**
 * The host a connection to `url` is opened to: its hostname, an IPv6 literal without the brackets the URL form needs. The probe and the door both derive their dial target from a base URL through this, because `net.isIP("[::1]")` is 0: a bracketed literal is taken for a name, goes to the resolver and fails with EBADNAME, whichever side dials it.
 */
export function dialHostOf(url: Readonly<Pick<URL, "hostname">>): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/** The default port of each scheme a base URL may use, for a URL that names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/** The host and port a base URL's connections are opened to; undefined for a scheme that is neither http nor https, which nothing dials. */
export function dialTargetOf(baseUrl: string): { readonly host: string; readonly port: number } | undefined {
  const url = new URL(baseUrl);
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    return undefined;
  }
  return { host: dialHostOf(url), port: url.port === "" ? defaultPort : Number(url.port) };
}
