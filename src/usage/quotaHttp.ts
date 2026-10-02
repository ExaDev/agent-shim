import type { QuotaHttpGet } from "./providerQuota";

/** The real `QuotaHttpGet`: Node's own `fetch`, which does not read proxy environment variables, so a refresh from the front door never routes back through it. */
export const realQuotaHttpGet: QuotaHttpGet = async (url, headers, signal) => {
  const response = await fetch(url, { method: "GET", headers: { ...headers }, signal });
  return { status: response.status, text: await response.text() };
};
