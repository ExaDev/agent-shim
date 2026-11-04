import { expect, it } from "vitest";

import { cliCatalogueFingerprint } from "./catalogueCredential";

it("reports malformed CLI auth without exposing file contents", () => {
  const malformed = '{"tokens":{"access_token":"secret-marker",INVALID';
  expect(() => cliCatalogueFingerprint(malformed)).toThrow("invalid Codex login file");
});
