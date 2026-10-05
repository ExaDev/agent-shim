import path from "node:path";

import type { FarmFs } from "../launcher/ports";
import type { RcObservedCredential } from "./rcSessions";

/**
 * The persisted half of the tracker's client credential and of its sequence cursor: the OAuth-kind bearer and protocol headers a Remote Control session's client-half calls were last observed with, and the highest sequence number the door's stream attachment had confirmed when its last attachment boundary passed, written per session id so a later door generation can still attach to a session whose create crossed an earlier one and resume its read stream from where the last generation left off.
 *
 * The tracker holds both in memory only, and the worker's recurring calls carry the worker JWT rather than the OAuth bearer, so a door that starts after the session's create (an idle shutdown and restart, a release upgrade, a reboot) would never learn the credential: nothing the door can observe re-states it until some client-half call happens to cross. Since the session outlives any one door process, the credential must outlive the process too, and so must the cursor, or every restarted generation would re-read the stream from its head. The credential is the same secret the identity's own store already holds on the same machine, so persisting it adds a second copy inside the same trust boundary, at the same owner-only protection: one JSON file per session, mode 0600, under the door's own front-door directory, with the cursor (no secret, but the same file and the same lifecycle) beside it. The native client does exactly this: its `bridge-session` transcript entry carries `lastSequenceNum` beside the session id.
 *
 * Each half is written at its own boundaries (the credential whenever an OAuth-kind bearer is observed, the cursor when the stream hub's attachment reaches a boundary), so each write preserves the other half, and neither is written per stream event. A file is removed when the tracker observes the session closing (the conflict header, or an accepted archive). Nothing else removes it: the tracker's idle sweep is not a close (a quiet session is not a dead one, and a resumed session must re-attach), and the credential's own expiry is the protocol's to judge, as a 401 on the dial the hub already retries and backs off from. A session that ends without an observable close leaves its file behind, overwritten only if the same id is ever observed again.
 */
export interface RcCredentialStore {
  /** The session's last observed client credential, or undefined when none was ever persisted for it (or what was persisted does not parse). */
  readonly read: (sessionId: string) => RcObservedCredential | undefined;
  /** Persists the session's client credential, replacing whatever was held for it and keeping the session's persisted cursor. */
  readonly write: (sessionId: string, credential: RcObservedCredential) => void;
  /** The session's persisted sequence cursor, or undefined when none was ever persisted for it (or what was persisted is not a usable number). */
  readonly readCursor: (sessionId: string) => number | undefined;
  /** Persists the session's sequence cursor, keeping whatever credential the same file holds. */
  readonly writeCursor: (sessionId: string, highestSequenceNum: number) => void;
  /** Forgets the session's persisted record, credential and cursor together, succeeding silently when none was held. */
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

/** The sequence cursor a persisted record names, or undefined when the field is absent or not a non-negative integer: the protocol's own numbers are positive integers, so anything else is a file this process did not write. */
function sequenceNumOfJson(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Creates the credential store over one directory: one owner-only JSON file per session id. */
export function createRcCredentialStore(fs: FarmFs, dir: string): RcCredentialStore {
  fs.mkdirPrivate(dir);
  const fileFor = (sessionId: string): string => path.join(dir, `${sessionId}.json`);
  /** Reads the session's whole persisted record as raw JSON fields, or undefined when no file exists or it does not parse: each half narrows its own fields out of this. */
  const readParsed = (sessionId: string): Record<string, unknown> | undefined => {
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
    return isRecord(parsed) ? parsed : undefined;
  };
  return {
    read: (sessionId) => {
      if (!isSafeSessionId(sessionId)) {
        return undefined;
      }
      return credentialOfJson(readParsed(sessionId));
    },
    write: (sessionId, credential) => {
      if (!isSafeSessionId(sessionId)) {
        return;
      }
      const cursor = sequenceNumOfJson(readParsed(sessionId)?.highestSequenceNum);
      const record = { ...credential, ...(cursor === undefined ? {} : { highestSequenceNum: cursor }) };
      fs.writeFilePrivate(fileFor(sessionId), `${JSON.stringify(record, null, 2)}\n`);
    },
    readCursor: (sessionId) => {
      if (!isSafeSessionId(sessionId)) {
        return undefined;
      }
      return sequenceNumOfJson(readParsed(sessionId)?.highestSequenceNum);
    },
    writeCursor: (sessionId, highestSequenceNum) => {
      if (!isSafeSessionId(sessionId)) {
        return;
      }
      const credential = credentialOfJson(readParsed(sessionId));
      const record = credential === undefined ? { highestSequenceNum } : { ...credential, highestSequenceNum };
      fs.writeFilePrivate(fileFor(sessionId), `${JSON.stringify(record, null, 2)}\n`);
    },
    remove: (sessionId) => {
      if (!isSafeSessionId(sessionId)) {
        return;
      }
      fs.removeRecursive(fileFor(sessionId));
    },
  };
}
