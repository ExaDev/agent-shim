/**
 * A provider's base URL as anything agent-shim prints shows it: scheme, host, port and path, without the userinfo, query and fragment a base URL may carry a credential in (`https://user:token@host/`, `?key=...`). Every report, log line and error that names a base URL, and the catalogue URLs derived from one, names it this way. The exceptions are deliberate: `provider show --json` prints the file's own fields so the value round-trips, the provider file itself and the requests the door and the catalogue fetch make carry the URL whole because they must reach it, and the hash `earlierReleaseAllowlistHash` takes of it is never printed. The path is printed as written, so a credential does not belong in it (a path such as `/bot<token>/`): the provider's `credential` block is where one goes, and a base URL's userinfo and query are what this keeps out of anything printed.
 */
export function displayBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const writtenBeforeQuery = baseUrl.split(/[?#]/, 1)[0] ?? baseUrl;
  return `${url.protocol}//${url.host}${url.pathname === "/" && !writtenBeforeQuery.endsWith("/") ? "" : url.pathname}`;
}

/**
 * `text` with every occurrence of `url`, as written and as `URL` normalises it, replaced by `displayBaseUrl(url)`: for an error message a dial or fetch raised, which quotes the URL it was given whole (userinfo and query included). Only the URL as a whole is replaced, and that is how the platform quotes it.
 */
export function redactUrlIn(text: string, url: string): string {
  const shown = displayBaseUrl(url);
  return text.split(url).join(shown).split(new URL(url).href).join(shown);
}
