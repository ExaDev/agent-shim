import type { IncomingHttpHeaders } from "node:http";

/** Whether a header name is the body's declared length, in whatever case it was spelt. */
function isContentLength(name: string): boolean {
  return name.toLowerCase() === "content-length";
}

/** `headers` without the declared body length: what a request carries once its body has changed length, so the forward re-frames it. */
export function withoutContentLength(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isContentLength(name)));
}

/** The body length `headers` declare, whatever the case of the header's name, or NaN when none is declared or it is not a number: a comparison with a limit is then false, as for any length that cannot be told. */
export function declaredLength(headers: Readonly<IncomingHttpHeaders>): number {
  const declared = Object.entries(headers).find(([name]) => isContentLength(name))?.[1];
  return Number(declared);
}
