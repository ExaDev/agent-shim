import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

import { withBlockingStep } from "./blockingSteps";
import { refuseToBlockInRole } from "./processRole";

/**
 * `spawnSync`, refused in a process whose event loop serves other processes. The one place in the package that may call `spawnSync`, so no path that blocks the calling thread for as long as a process takes to start can reach the front door without failing at its first step (the lint rule `no-restricted-imports` bans the direct import everywhere else). `operation` names what the caller was doing, for the error. Every call is also a blocking step (`withBlockingStep`): its `timeout` is the step's bound, and where a process observes its steps one named by no timeout is given the observer's limit.
 */
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function spawnSyncBlocking(operation: string, command: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  refuseToBlockInRole(operation);
  return withBlockingStep(options?.timeout, (boundMs) => spawnSync(command, args, { ...options, ...(boundMs === undefined ? {} : { timeout: boundMs }) }));
}
