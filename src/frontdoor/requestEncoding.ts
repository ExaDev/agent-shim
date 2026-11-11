import { quotedForLog } from "./loggedText";

/** The header names and values of a request or an answer: a request's come from the server (values may be lists), an answer's from a route (always strings). */
type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The codings `headers` name in `Content-Encoding`, in whatever case the header's name is spelt and whether its value is one string or a list, each coding trimmed and empty ones left out. */
function codingsOf(headers: Headers): readonly string[] {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "content-encoding")
    .flatMap(([, value]) => [value ?? []].flat())
    .flatMap((listed) => listed.split(","))
    .map((coding) => coding.trim())
    .filter((coding) => coding !== "");
}

/** Whether the headers say the body is encoded (`Content-Encoding` other than `identity`): the bytes of such a body are not the text it carries, so nothing can be read off them or matched in them. */
export function isEncoded(headers: Headers): boolean {
  return codingsOf(headers).some((coding) => coding.toLowerCase() !== "identity");
}

/**
 * What the 415 for a Messages request whose body is encoded says, the same at every site that reads a request body as JSON text to find or replace its model (the resolver's scans and the editing wrapper): an encoded body would be forwarded with the name it spells, whatever the door was asked to do with it. `undefined` when the body is not encoded.
 */
export function encodedRequestMessage(headers: Headers, provider?: string): string | undefined {
  if (!isEncoded(headers)) {
    return undefined;
  }
  const codings = codingsOf(headers).map(quotedForLog).join(", ");
  return `${provider === undefined ? "" : `provider "${provider}": `}the request body is encoded (Content-Encoding: ${codings}), and the model it names cannot be read from an encoded body; send it unencoded`;
}
