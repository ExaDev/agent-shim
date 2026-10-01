import { createHash } from "node:crypto";
import path from "node:path";

/** How many hex digits of the combined bundle's SHA-256 name its file: enough that two different bundles never share a name on one machine. */
const BUNDLE_NAME_HEX_DIGITS = 16;

/** The file effects resolving a trust bundle needs, injected so the decision runs against fakes. */
export interface TrustBundleFs {
  /** Reads a file as UTF-8 text; throws when it cannot be read. */
  readonly readFileUtf8: (file: string) => string;
  /** Whether a file exists. */
  readonly exists: (file: string) => boolean;
  /** Creates a directory and any missing parents. */
  readonly mkdirp: (dir: string) => void;
  /** Writes a file atomically (a reader never sees a partial bundle). */
  readonly writeFileAtomic: (file: string, contents: string) => void;
}

/** The CA bundle a routed child is pointed at through `NODE_EXTRA_CA_CERTS`, and why it differs from what the parent environment set, when it does. */
export interface TrustBundle {
  readonly path: string;
  readonly warning?: string;
}

/**
 * Decides the `NODE_EXTRA_CA_CERTS` a routed child gets. Node reads exactly one file from that variable, so a user who already set it (a corporate proxy's CA, say) would lose that trust if the launcher simply pointed it at claude-use's CA. Instead:
 *
 * - nothing inherited: claude-use's CA file itself;
 * - an inherited file that already contains claude-use's CA (a launch from inside a routed session): that file, unchanged;
 * - any other readable inherited file: a combined bundle (the inherited certificates, then claude-use's CA) written once under `bundlesDir`, named by its content hash so concurrent launches agree on it and a live child's file is never rewritten under it;
 * - an inherited file that cannot be read: claude-use's CA alone, with a warning naming the file. Node itself would have ignored that file with a warning, so the child loses no trust it would otherwise have had.
 */
export function resolveTrustBundle(params: { readonly caCertFile: string; readonly bundlesDir: string; readonly inherited: string | undefined; readonly fs: TrustBundleFs }): TrustBundle {
  const { caCertFile, bundlesDir, inherited, fs } = params;
  if (inherited === undefined || inherited === "" || path.resolve(inherited) === path.resolve(caCertFile)) {
    return { path: caCertFile };
  }
  const caPem = fs.readFileUtf8(caCertFile);
  let inheritedPem: string;
  try {
    inheritedPem = fs.readFileUtf8(inherited);
  } catch (error) {
    return {
      path: caCertFile,
      warning: `claude-use: NODE_EXTRA_CA_CERTS names ${inherited}, which could not be read (${error instanceof Error ? error.message : String(error)}); the child trusts claude-use's front-door CA on top of the system store, and nothing from that file`,
    };
  }
  if (inheritedPem.includes(caPem.trim())) {
    return { path: inherited };
  }
  const combined = `${inheritedPem.trimEnd()}\n${caPem}`;
  const bundle = path.join(bundlesDir, `${createHash("sha256").update(combined).digest("hex").slice(0, BUNDLE_NAME_HEX_DIGITS)}.pem`);
  if (!fs.exists(bundle)) {
    fs.mkdirp(bundlesDir);
    fs.writeFileAtomic(bundle, combined);
  }
  return { path: bundle };
}
