import nodeFs from "node:fs";

import { realFarmFs } from "../realPorts";
import type { AgentReadFs } from "./read";

/** The reads the session commands and procedures make: the reader's own, plus resolving a path to the real location it points at, which is how identities sharing one history store are told from identities with their own. */
export interface SessionCommandFs extends AgentReadFs {
  /** The real path `candidate` resolves to, or undefined when nothing is there. */
  readonly realpath: (candidate: string) => string | undefined;
}

/** The real filesystem, for the commands and the door's sessions procedures. */
export const realSessionFs: SessionCommandFs = {
  ...realFarmFs,
  realpath: (candidate) => {
    try {
      return nodeFs.realpathSync(candidate);
    } catch {
      // An identity that has never run a session has no projects directory; that is the answer, not an error.
      return undefined;
    }
  },
};

