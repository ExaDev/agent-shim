import { describe, expect, it } from "vitest";

import { resolveTrustBundle, type TrustBundleFs } from "./trust";

const CA_FILE = "/home/testuser/.claude-use/frontdoor/ca/ca.pem";
const BUNDLES_DIR = "/home/testuser/.claude-use/frontdoor/ca/bundles";
/** Made-up PEM bodies: the resolver treats certificates as opaque text. */
const CA_PEM = "-----BEGIN CERTIFICATE-----\nclaude-use-ca\n-----END CERTIFICATE-----\n";
const CORPORATE_PEM = "-----BEGIN CERTIFICATE-----\ncorporate-proxy-ca\n-----END CERTIFICATE-----\n";

/** An in-memory filesystem holding the given files, recording every write. */
function memoryFs(initial: Readonly<Record<string, string>>): TrustBundleFs & { readonly writes: string[]; readonly files: Record<string, string> } {
  const writes: string[] = [];
  const files: Record<string, string> = { ...initial };
  return {
    writes,
    files,
    readFileUtf8: (file) => {
      const contents = files[file];
      if (contents === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${file}'`);
      }
      return contents;
    },
    exists: (file) => files[file] !== undefined,
    mkdirp: () => undefined,
    writeFileAtomic: (file, contents) => {
      writes.push(file);
      files[file] = contents;
    },
  };
}

describe("resolveTrustBundle", () => {
  it("uses the CA file itself when the parent set no NODE_EXTRA_CA_CERTS", () => {
    const fs = memoryFs({ [CA_FILE]: CA_PEM });
    expect(resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: undefined, fs })).toEqual({ path: CA_FILE });
    expect(resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: "", fs })).toEqual({ path: CA_FILE });
    expect(fs.writes).toEqual([]);
  });

  it("keeps a user's own bundle by combining it with the CA, rather than replacing it", () => {
    const fs = memoryFs({ [CA_FILE]: CA_PEM, "/etc/corp.pem": CORPORATE_PEM });
    const bundle = resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: "/etc/corp.pem", fs });
    expect(bundle.warning).toBeUndefined();
    expect(bundle.path.startsWith(`${BUNDLES_DIR}/`)).toBe(true);
    const combined = fs.files[bundle.path] ?? "";
    expect(combined).toContain(CORPORATE_PEM.trim());
    expect(combined).toContain(CA_PEM.trim());
    // The same combination resolves to the same file and is not rewritten under a live child.
    expect(resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: "/etc/corp.pem", fs }).path).toBe(bundle.path);
    expect(fs.writes).toEqual([bundle.path]);
  });

  it("reuses an inherited bundle that already trusts the CA, as a launch from inside a routed session inherits", () => {
    const fs = memoryFs({ [CA_FILE]: CA_PEM, "/bundles/x.pem": `${CORPORATE_PEM}${CA_PEM}` });
    expect(resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: "/bundles/x.pem", fs })).toEqual({ path: "/bundles/x.pem" });
    expect(resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: CA_FILE, fs })).toEqual({ path: CA_FILE });
    expect(fs.writes).toEqual([]);
  });

  it("falls back to the CA alone with a warning naming an inherited file that cannot be read", () => {
    const fs = memoryFs({ [CA_FILE]: CA_PEM });
    const bundle = resolveTrustBundle({ caCertFile: CA_FILE, bundlesDir: BUNDLES_DIR, inherited: "/missing.pem", fs });
    expect(bundle.path).toBe(CA_FILE);
    expect(bundle.warning).toContain("/missing.pem");
  });
});
