import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
  type ExecFileSyncOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

import { refuseToBlockInRole } from "./processRole";

/**
 * `spawnSync`, refused in a process whose event loop serves other processes. The one place in the package that may call `spawnSync`, so no path that blocks the calling thread for as long as a process takes to start can reach the front door without failing at its first step (the lint rule `no-restricted-imports` bans the direct import everywhere else). `operation` names what the caller was doing, for the error.
 */
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  refuseToBlockInRole(operation);
  return spawnSync(command, args, options ?? {});
}

/** `execFileSync`, refused in a process whose event loop serves other processes, for the same reason as `spawnSyncBlocking`. */
export function execFileSyncBlocking(operation: string, file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execFileSyncBlocking(operation: string, file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execFileSyncBlocking(operation: string, file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer {
  refuseToBlockInRole(operation);
  return execFileSync(file, args, options ?? {});
}
