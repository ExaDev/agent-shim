import * as fs from "node:fs";

import { realSessionFs } from "../agents/realFs";
import type { RcSessionRegistryFs } from "./rcSessionRegistry";

/**
 * The real filesystem the registry reader runs on. Its `statEntry` is an `lstat`, which never follows a link, and reports a node as regular only when it is a plain file: a FIFO, a socket, a device or a link to one named like an entry is therefore never opened (opening a FIFO for reading blocks until a writer appears, and the door's event loop would wait with it). A path that is not there answers undefined.
 */
export const realRcSessionRegistryFs: RcSessionRegistryFs = {
  readdir: realSessionFs.readdir,
  readFileUtf8: realSessionFs.readFileUtf8,
  realpath: realSessionFs.realpath,
  statEntry: (entryPath) => {
    try {
      const stat = fs.lstatSync(entryPath);
      return { regular: stat.isFile(), sizeBytes: stat.size };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
};
