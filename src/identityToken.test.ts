import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UsageError } from "./cliError";
import { TOKEN_DIR_MODE, TOKEN_FILE_MODE, identityTokenPath, storeIdentityToken } from "./identityToken";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

const PERMISSION_BITS = 0o777;
const TOKEN = "sk-ant-REDACTED";

describe("storeIdentityToken", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-token-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the trimmed token at mode 0600 in a 0700 directory and returns its path", () => {
    const written = storeIdentityToken(paths, "work", `  ${TOKEN}\n`);
    expect(written).toBe(identityTokenPath(paths, "work"));
    expect(fs.readFileSync(written, "utf8")).toBe(`${TOKEN}\n`);
    expect(fs.statSync(written).mode & PERMISSION_BITS).toBe(TOKEN_FILE_MODE);
    expect(fs.statSync(path.dirname(written)).mode & PERMISSION_BITS).toBe(TOKEN_DIR_MODE);
  });

  it("replaces an earlier token for the same identity", () => {
    storeIdentityToken(paths, "work", TOKEN);
    const written = storeIdentityToken(paths, "work", "sk-ant-REDACTED");
    expect(fs.readFileSync(written, "utf8")).toBe("sk-ant-REDACTED\n");
  });

  it("refuses text that is not shaped like a setup-token token, without writing or echoing it", () => {
    const wrong = "sk-ant-REDACTED";
    expect(() => storeIdentityToken(paths, "work", wrong)).toThrow(UsageError);
    try {
      storeIdentityToken(paths, "work", wrong);
    } catch (error) {
      expect(String(error)).not.toContain(wrong);
    }
    expect(fs.existsSync(identityTokenPath(paths, "work"))).toBe(false);
  });
});
