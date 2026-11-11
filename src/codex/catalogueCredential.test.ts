import { describe, expect, it } from "vitest";

import type { CodexProvider } from "../config/schema";
import { TolerantReader, skipUnreadableCatalogue } from "../storedCatalogue";
import { catalogueCredentialFingerprint, cliCatalogueFingerprint, savedCatalogueFingerprint } from "./catalogueCredential";

it("reports malformed CLI auth without exposing file contents", () => {
  const malformed = '{"tokens":{"access_token":"secret-marker",INVALID';
  expect(() => cliCatalogueFingerprint(malformed)).toThrow("invalid Codex login file");
});

const SIGN_IN_PATH = "/state/chatgpt-sign-in.json";
const CLI_AUTH_PATH = "/home/user/.codex/auth.json";
const signInFile = (accessToken: string): string => JSON.stringify({ grant: { clientId: "client", sub: "subject", idToken: "id-token", accessToken, refreshToken: "refresh", scopes: ["chatgpt.tokens.use.direct"], expiresAt: 1 } });
const cliFile = (accessToken: string): string => JSON.stringify({ tokens: { access_token: accessToken, account_id: "workspace" } });
const codexProvider = (login?: "chatgpt-sign-in"): CodexProvider => ({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] }, ...(login === undefined ? {} : { codex: { login } }) });
/** A reader over `files` that notes in `read` each file it is asked for. */
const readerOf = (files: Readonly<Record<string, string>>, read: { readonly files: string[] } = { files: [] }): TolerantReader => new TolerantReader((file) => {
  read.files.push(file);
  return files[file];
}, skipUnreadableCatalogue);

describe("the login a Codex catalogue is bound to", () => {
  const paths = { chatgptSignInFile: SIGN_IN_PATH };

  it("is, for a Sign in with ChatGPT provider, the grant in the sign-in file, which differs with the grant, and none without one", () => {
    const first = savedCatalogueFingerprint(codexProvider("chatgpt-sign-in"), paths, {}, "/home/user", readerOf({ [SIGN_IN_PATH]: signInFile("token-one") }));
    const second = savedCatalogueFingerprint(codexProvider("chatgpt-sign-in"), paths, {}, "/home/user", readerOf({ [SIGN_IN_PATH]: signInFile("token-two") }));
    expect(first).toBe(catalogueCredentialFingerprint(false, "token-one", undefined));
    expect(second).toBe(catalogueCredentialFingerprint(false, "token-two", undefined));
    expect(first).not.toBe(second);
    expect(savedCatalogueFingerprint(codexProvider("chatgpt-sign-in"), paths, {}, "/home/user", readerOf({}))).toBeUndefined();
  });

  it("is, for the CLI's own login, the account file of the Codex home the environment names, else of the home directory, and reads no other", () => {
    const read = { files: [] as string[] };
    const named = savedCatalogueFingerprint(codexProvider(), paths, { CODEX_HOME: "/elsewhere" }, "/home/user", readerOf({ "/elsewhere/auth.json": cliFile("named"), [CLI_AUTH_PATH]: cliFile("home") }, read));
    expect(named).toBe(catalogueCredentialFingerprint(true, "named", "workspace"));
    expect(read.files).toEqual(["/elsewhere/auth.json"]);
    const homed = savedCatalogueFingerprint(codexProvider(), paths, { CODEX_HOME: "" }, "/home/user", readerOf({ [CLI_AUTH_PATH]: cliFile("home") }));
    expect(homed).toBe(catalogueCredentialFingerprint(true, "home", "workspace"));
  });

  it("reads the sign-in file for a sign-in provider and never the CLI's, and the CLI's for the others and never the sign-in file", () => {
    const read = { files: [] as string[] };
    savedCatalogueFingerprint(codexProvider("chatgpt-sign-in"), paths, {}, "/home/user", readerOf({}, read));
    savedCatalogueFingerprint(codexProvider(), paths, {}, "/home/user", readerOf({}, read));
    expect(read.files).toEqual([SIGN_IN_PATH, CLI_AUTH_PATH]);
  });
});
