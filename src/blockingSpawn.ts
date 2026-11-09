import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

import { refuseToBlockInRole } from "./processRole";

/** The options of a bounded blocking spawn: whatever `spawnSync` takes, with the `timeout` it must name. */
type Bounded<T extends SpawnSyncOptions> = T & { readonly timeout: number };

/**
 * `spawnSync`, refused in a process whose event loop serves other processes, and bounded: the options must name a `timeout`, which is what makes the longest blocking step of a door worker task known (`src/doorBounds.ts`). The one place in the package that may call `spawnSync` for work with an end, so no path that blocks the calling thread for as long as a process takes bypasses the door's refusal or runs without a limit.
 */
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: Bounded<SpawnSyncOptionsWithStringEncoding>): SpawnSyncReturns<string>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: Bounded<SpawnSyncOptionsWithBufferEncoding>): SpawnSyncReturns<Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: Bounded<SpawnSyncOptions>): SpawnSyncReturns<string | Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: Bounded<SpawnSyncOptions>): SpawnSyncReturns<string | Buffer> {
  refuseToBlockInRole(operation);
  return spawnSync(command, args, options);
}

/**
 * `spawnSync` with no timeout, refused in the door like the bounded form. For the one program whose run is the session itself, the real `claude` a launch hands the terminal to, which lasts as long as the person keeps it; a test (`blockingSpawn.test.ts`) holds this to that one caller.
 */
export function spawnSyncUnbounded(operation: string, command: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  refuseToBlockInRole(operation);
  return spawnSync(command, args, options);
}
