/**
 * A provider's base URL as anything agent-shim prints shows it: scheme, host, port and path, without the userinfo, query and fragment a base URL may carry a credential in (`https://user:token@host/`, `?key=...`). Every report, log line and error that names a base URL, and the catalogue URLs derived from one, names it this way. The exceptions are deliberate: `provider show --json` prints the file's own fields so the value round-trips, the provider file itself and the requests the door and the catalogue fetch make carry the URL whole because they must reach it, and the hash `earlierReleaseAllowlistHash` takes of it is never printed.
 */
export function displayBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}${url.pathname === "/" && !baseUrl.endsWith("/") ? "" : url.pathname}`;
}
