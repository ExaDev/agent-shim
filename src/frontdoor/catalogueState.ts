import path from "node:path";
import { z } from "zod";

import type { CatalogueKeeperDeps } from "../catalogueKeeper";
import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { StoredCatalogue, catalogueFailureFile, catalogueStatusFile } from "../storedCatalogue";
import { skippingReader } from "../tolerantReaders";

/** Stores one provider's refresh state within the supervisor generation that owns it. */
export function writeCatalogueStatus(fs: HeadroomFs, paths: LayoutPaths, pid: number, generation: string, name: string, status: "running" | "ready" | "failed", fingerprint?: string, recordedAt?: number): void {
  fs.mkdirp(path.dirname(catalogueStatusFile(paths, { pid, generation }, name)));
  fs.writeFilePrivate(catalogueStatusFile(paths, { pid, generation }, name), JSON.stringify({ status, ...(fingerprint === undefined ? {} : { fingerprint }), ...(recordedAt === undefined ? {} : { recordedAt }) }));
}

/** The longest a recorded refresh failure reason is kept, in characters: a refresh error names each candidate URL and its outcome, which is a few hundred at most. */
export const CATALOGUE_FAILURE_REASON_MAX_CHARS = 600;

/** Records why `name`'s refresh failed, the reason cut to `CATALOGUE_FAILURE_REASON_MAX_CHARS`, and whether it was a redirect, as a field of its own that the cut cannot remove; a refresh that did not fail clears it (`reason` undefined). */
export function writeCatalogueFailureReason(fs: HeadroomFs, paths: LayoutPaths, pid: number, generation: string, name: string, reason: string | undefined, failure: Readonly<{ readonly redirected?: true; readonly unlocated?: true; readonly settings?: string }> = {}): void {
  const file = catalogueFailureFile(paths, { pid, generation }, name);
  if (reason === undefined) {
    fs.removeRecursive(file);
    return;
  }
  fs.mkdirp(path.dirname(file));
  fs.writeFilePrivate(file, JSON.stringify({ reason: reason.slice(0, CATALOGUE_FAILURE_REASON_MAX_CHARS), ...(failure.redirected === true ? { redirected: true } : {}), ...(failure.redirected === true && failure.unlocated === true ? { unlocated: true } : {}), ...(failure.settings === undefined ? {} : { settings: failure.settings }) }));
}

/** Reads why `name`'s last refresh failed in a supervisor generation, and whether it was a redirect, or undefined when none is recorded, the file cannot be read or it is not one this release wrote. */
export function readCatalogueFailure(fs: Pick<HeadroomFs, "readFileUtf8">, paths: LayoutPaths, pid: number, generation: string, name: string): { readonly reason: string; readonly redirected: boolean; readonly unlocated: boolean; readonly settings: string | undefined } | undefined {
  const raw = new StoredCatalogue(paths, skippingReader(fs)).failureText({ pid, generation }, name);
  if (raw === undefined) return undefined;
  try {
    const value = z.strictObject({ reason: z.string().max(CATALOGUE_FAILURE_REASON_MAX_CHARS), redirected: z.literal(true).optional(), unlocated: z.literal(true).optional(), settings: z.string().optional() }).safeParse(JSON.parse(raw));
    return value.success ? { reason: value.data.reason, redirected: value.data.redirected === true, unlocated: value.data.redirected === true && value.data.unlocated === true, settings: value.data.settings } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The keeper's `publishStatus` over the door's own state files: the status file an older launcher reads, unchanged in shape, and beside it the reason a refresh failed, whether it was a redirect and the settings it was read under (cleared by any state that is not a failure), which `doctor` and the launcher's wait read.
 */
export function catalogueStatusPublisher(fs: HeadroomFs, paths: LayoutPaths, supervisorPid: number, generation: string, nowMs: () => number): NonNullable<CatalogueKeeperDeps["publishStatus"]> {
  return (name, status, fingerprint, reason, failure) => {
    writeCatalogueStatus(fs, paths, supervisorPid, generation, name, status, fingerprint, nowMs());
    writeCatalogueFailureReason(fs, paths, supervisorPid, generation, name, status === "failed" ? reason : undefined, status === "failed" ? failure : undefined);
  };
}

/** Reads the refresh state recorded for a provider in a supervisor generation: none when nothing is recorded or the file cannot be read. */
export function readCatalogueStatus(fs: Pick<HeadroomFs, "readFileUtf8">, paths: LayoutPaths, pid: number, generation: string, name: string): { readonly status: "running" | "ready" | "failed"; readonly fingerprint?: string; readonly recordedAt?: number } | undefined {
  const raw = new StoredCatalogue(paths, skippingReader(fs)).statusText({ pid, generation }, name);
  if (raw === undefined) return undefined;
  try {
    const value = z.strictObject({ status: z.enum(["running", "ready", "failed"]), fingerprint: z.string().min(1).optional(), recordedAt: z.number().optional() }).safeParse(JSON.parse(raw));
    return value.success ? value.data : undefined;
  } catch {
    return undefined;
  }
}
