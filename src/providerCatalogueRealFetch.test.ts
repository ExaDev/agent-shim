import { describe, expect, it } from "vitest";

import { fetchCatalogue } from "./providerCatalogue";
import { realCatalogueFetch } from "./realCatalogueRefresh";

const CREDENTIAL = { target: "bearer", token: "unrelated-token" } as const;

describe("fetchCatalogue over the real fetch", () => {
  it("names a rejected URL without its userinfo or query, which the platform's own message quotes whole", async () => {
    const provider = { baseUrl: "https://user:passw0rd-marker@127.0.0.1:9/api?key=key-marker" };
    const failure = await fetchCatalogue({ provider, catalogue: {}, credential: CREDENTIAL, fetch: realCatalogueFetch, now: () => 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("https://127.0.0.1:9/api/v1/models");
    expect(message).not.toContain("passw0rd-marker");
    expect(message).not.toContain("key-marker");
  });
});
