import path from "node:path";

import type { FarmFs, LogPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { isSessionStateFile } from "./hookGuard";
import { readSessionState, sessionStatePath, stateDirOf } from "./registry";
import type { realWatchDirectory, realWatchExistingDirectory } from "./realPorts";

/** The directory watches `watchSessionFiles` is built on, injected so a test can run it against fakes. */
interface DirectoryWatchPorts {
  readonly directory: typeof realWatchDirectory;
  readonly existingDirectory: typeof realWatchExistingDirectory;
}

/** What watching one session's own files needs. */
interface SessionFilesWatch {
  readonly paths: LayoutPaths;
  readonly pool: string;
  /** The launch id the session's state is recorded under, which a /clear leaves unchanged. */
  readonly sessionId: string;
  /** Whether the session's transcript is watched as well as its state: only a pool that compacts reads a transcript for a Stop summary. */
  readonly watchTranscript: boolean;
  readonly fs: Pick<FarmFs, "readFileUtf8" | "lstat">;
  readonly log: LogPort;
  readonly watch: DirectoryWatchPorts;
}

/**
 * Calls `onChange` when the session's own recorded state changes, or when its own transcript is written, and returns the function that stops watching.
 *
 * Both files live in directories shared with every concurrent session (the pool's state directory, and the project's transcript directory), so each watch accepts only this session's names: a write by a sibling would otherwise wake every supervisor for nothing. The transcript is the file the state names, which a /clear re-points: each state change re-reads the name, and moves the watch when the directory differs.
 */
export function watchSessionFiles(params: Readonly<SessionFilesWatch>): (onChange: () => void) => () => void {
  const { paths, pool, sessionId, fs, log, watch } = params;
  const stateFile = path.basename(sessionStatePath(paths, pool, sessionId));
  return (onChange) => {
    let watchedDir: string | undefined;
    let transcriptName: string | undefined;
    let stopTranscripts: (() => void) | undefined;
    let transcriptWarning = "";
    const followTranscript = (): void => {
      const transcript = readSessionState(fs, paths, pool, sessionId)?.transcriptPath;
      const directory = transcript === undefined ? undefined : path.dirname(transcript);
      transcriptName = transcript === undefined ? undefined : path.basename(transcript);
      if (!params.watchTranscript || directory === watchedDir) {
        return;
      }
      stopTranscripts?.();
      watchedDir = undefined;
      stopTranscripts = undefined;
      if (directory !== undefined && fs.lstat(directory) !== undefined) {
        try {
          stopTranscripts = watch.existingDirectory(directory, (filename) => filename === transcriptName, "the session transcript", log)(onChange);
          watchedDir = directory;
          transcriptWarning = "";
        } catch (error) {
          const warning = `agent-shim: could not watch the session transcript: ${error instanceof Error ? error.message : String(error)}`;
          if (warning !== transcriptWarning) {
            transcriptWarning = warning;
            log.warn(warning);
          }
        }
      }
    };
    // A state change can name a new transcript after /clear; follow it before the check for the later Stop summary.
    const stopState = watch.directory(stateDirOf(paths, pool), (filename) => isSessionStateFile(sessionId, stateFile, filename), "the session's state", log)(() => {
      followTranscript();
      onChange();
    });
    followTranscript();
    return () => {
      stopState();
      stopTranscripts?.();
    };
  };
}
