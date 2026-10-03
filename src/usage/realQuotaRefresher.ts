import { realCredentialPort, realFarmFs, realFsPort } from "../realPorts";
import type { LayoutPaths } from "../paths";
import { createProviderLookup, createQuotaRefresher, type QuotaRefresher } from "./quotaRefresh";
import { realQuotaHttpGet } from "./quotaHttp";
import { readUsageSnapshot, UsageSnapshotError } from "./read";
import type { UsageStore } from "./store";

/** The refresher wired to the real filesystem, credential sources and network: what the front door and `agent-shim usage --refresh` both run, so a manual refresh and an automatic one authenticate and record identically. */
export function createRealQuotaRefresher(params: { readonly paths: LayoutPaths; readonly store: UsageStore; readonly log: (line: string) => void }): QuotaRefresher {
  const { paths, store, log } = params;
  return createQuotaRefresher({
    lookup: createProviderLookup({ fs: realFsPort, providersDir: paths.providersDir, env: process.env, credentials: realCredentialPort }),
    http: realQuotaHttpGet,
    readQuota: (identity, provider) => {
      try {
        return readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity)?.providers[provider]?.quota;
      } catch (error) {
        if (error instanceof UsageSnapshotError) {
          return undefined;
        }
        throw error;
      }
    },
    record: store.recordQuota,
    now: () => Date.now(),
    log,
  });
}
