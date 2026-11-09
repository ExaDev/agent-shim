/**
 * The host a connection to `url` is opened to: its hostname, an IPv6 literal without the brackets the URL form needs. The probe and the door both derive their dial target from a base URL through this, because `net.isIP("[::1]")` is 0: a bracketed literal is taken for a name, goes to the resolver and fails with EBADNAME, whichever side dials it.
 */
export function dialHostOf(url: Readonly<Pick<URL, "hostname">>): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/** The default port of each scheme a base URL may use, for a URL that names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/**
 * The host and port a base URL's connections are opened to. The URL is an `http` provider's base URL, which the schema holds to http or https and a port a listener can have (`HttpBaseUrlSchema`), so any other scheme is a caller's fault and throws.
 */
export function dialTargetOf(baseUrl: string): { readonly host: string; readonly port: number } {
  const url = new URL(baseUrl);
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    throw new Error(`${url.protocol} is not a scheme a provider's base URL can have`);
  }
  return { host: dialHostOf(url), port: url.port === "" ? defaultPort : Number(url.port) };
}
