import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CredentialSourceSchema } from "./config/schema";
import { KEYCHAIN_CACHE_SERVICE, KEYCHAIN_ITEM_NOT_FOUND_STATUS } from "./credentialCache";
import { KeychainCacheDeleteError } from "./keychainLogin";
import { createRealCredentialCache } from "./realCredentialCache";

/** A failure `security` gives that is not an item it cannot find, as a locked Keychain gives. */
const LOCKED = 51;

describe("the Keychain store of the credential cache", () => {
  it("reports a delete security refused, and takes an entry that is not there as already forgotten", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-cache-delete-test-"));
    try {
      const refusing = createRealCredentialCache(root, { run: () => ({ status: LOCKED, stdout: "" }), platform: "darwin" });
      expect(() => {
        refusing.remove("keychain", "identity work");
      }).toThrow(KeychainCacheDeleteError);
      expect(() => {
        refusing.remove("keychain", "identity work");
      }).toThrow(`security delete-generic-password -s '${KEYCHAIN_CACHE_SERVICE}' -a 'identity work'`);
      const absent = createRealCredentialCache(root, { run: () => ({ status: KEYCHAIN_ITEM_NOT_FOUND_STATUS, stdout: "" }), platform: "darwin" });
      expect(() => {
        absent.remove("keychain", "identity work");
      }).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The cached-credential schema of the release before owners were recorded (11.83.4): a strict object, so an entry with an `owner` is rejected by that release. */
const ReleasedCachedCredentialSchema = z.strictObject({
  token: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
  source: CredentialSourceSchema,
});

describe("an entry the Keychain store writes", () => {
  it("records no owner, which the account it is filed under already is, so a release from before owners were recorded reads it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-cache-keychain-entry-test-"));
    try {
      const inputs: string[] = [];
      const cache = createRealCredentialCache(root, {
        run: (_args, stdin) => {
          if (stdin !== undefined) {
            inputs.push(stdin);
          }
          return { status: 0, stdout: "" };
        },
        platform: "darwin",
      });
      cache.write("keychain", "identity a@b", { token: "a-made-up-token", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } });
      const encoded = /-w (?<encoded>\S+)/u.exec(inputs[0] ?? "")?.groups?.encoded ?? "";
      const entry: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      expect(ReleasedCachedCredentialSchema.safeParse(entry).success).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
