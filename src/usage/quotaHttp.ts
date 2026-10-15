import type { QuotaHttpGet } from "./providerQuota";

/** The real `QuotaHttpGet`: Node's own `fetch`, which does not read proxy environment variables, so a refresh from the front door never routes back through it. */
export const realQuotaHttpGet: QuotaHttpGet = async (url, headers, signal, options) => {
  const response = await fetch(url, { method: options?.method ?? "GET", headers: { ...headers }, ...(options?.body === undefined ? {} : { body: options.body }), signal });
  return { status: response.status, text: await response.text() };
};
