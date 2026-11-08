/**
 * A provider's base URL as anything agent-shim prints shows it: scheme, host, port and path, without the userinfo, query and fragment a base URL may carry a credential in (`https://user:token@host/`, `?key=...`). Every report, log line and error that names a base URL names it this way; only `provider show --json`, which prints the file's own fields, gives it whole.
 */
export function displayBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}${url.pathname === "/" && !baseUrl.endsWith("/") ? "" : url.pathname}`;
}
