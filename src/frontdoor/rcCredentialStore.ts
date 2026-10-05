import path from "node:path";

import type { FarmFs } from "../launcher/ports";
import type { RcObservedCredential } from "./rcSessions";

/**
 * The persisted half of the tracker's client credential: the OAuth-kind bearer and protocol headers a Remote Control session's client-half calls were last observed with, written per session id so a later door generation can still attach to a session whose create crossed an earlier one.
 *
 * The tracker holds the credential in memory only, and the worker's recurring calls carry the worker JWT rather than the OAuth bearer, so a door that starts after the session's create (an idle shutdown and restart, a release upgrade, a reboot) would never learn it: nothing the door can observe re-states it until some client-half call happens to cross. Since the session outlives any one door process, the credential must outlive the process too. It is the same secret the identity's own store already holds on the same machine, so persisting it adds a second copy inside the same trust boundary, at the same owner-only protection: one JSON file per session, mode 0600, under the door's own front-door directory.
 *
 * A file is removed when the tracker observes the session closing (the conflict header, or an accepted archive). Nothing else removes it: the tracker's idle sweep is not a close (a quiet session is not a dead one, and a resumed session must re-attach), and the credential's own expiry is the protocol's to judge, as a 401 on the dial the hub already retries and backs off from. A session that ends without an observable close leaves its file behind, overwritten only if the same id is ever observed again.
 */
export interface RcCredentialStore {
  /** The session's last observed client credential, or undefined when none was ever persisted for it (or what was persisted does not parse). */
  readonly read: (sessionId: string) => RcObservedCredential | undefined;
  /** Persists the session's client credential, replacing whatever was held for it. */
  readonly write: (sessionId: string, credential: RcObservedCredential) => void;
  /** Forgets the session's persisted credential, succeeding silently when none was held. */
  readonly remove: (sessionId: string) => void;
}

/** The file names this store writes are session ids, whose alphabet (`cse_` plus UUID characters) contains no path separator; the check keeps that true rather than trusting it. */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one persisted credential's fields, or undefined when any field is absent or not a string: a file this process did not write (or a truncated one) is one the store knows nothing of, and the next live observation overwrites it. */
function credentialOfJson(parsed: unknown): RcObservedCredential | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { authorization, anthropicVersion, anthropicClientPlatform } = parsed;
  if (typeof authorization !== "string" || authorization === "") {
    return undefined;
  }
  return {
    authorization,
    anthropicVersion: typeof anthropicVersion === "string" ? anthropicVersion : undefined,
    anthropicClientPlatform: typeof anthropicClientPlatform === "string" ? anthropicClientPlatform : undefined,
  };
}

/** Creates the credential store over one directory: one owner-only JSON file per session id. */
export function createRcCredentialStore(fs: FarmFs, dir: string): RcCredentialStore {
  fs.mkdirPrivate(dir);
  const fileFor = (sessionId: string): string => path.join(dir, `${sessionId}.json`);
  return {
    read: (sessionId) => {
      if (!isSafeSessionId(sessionId)) {
        return undefined;
      }
      const raw = fs.readFileUtf8(fileFor(sessionId));
      if (raw === undefined) {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      return credentialOfJson(parsed);
    },
    write: (sessionId, credential) => {
      if (!isSafeSessionId(sessionId)) {
        return;
      }
      fs.writeFilePrivate(fileFor(sessionId), `${JSON.stringify(credential, null, 2)}\n`);
    },
    remove: (sessionId) => {
      if (!isSafeSessionId(sessionId)) {
        return;
      }
      fs.removeRecursive(fileFor(sessionId));
    },
  };
}
