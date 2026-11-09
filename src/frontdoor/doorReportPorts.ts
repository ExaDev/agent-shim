import { DoorReportUnavailableError, type ControlApiDeps } from "./controlApi";

/**
 * The `check.run` and `doctor.run` dependencies of the command line's own front door. The reports run external commands, read the keychain and probe providers, every one of which blocks the calling thread, which the door's event loop refuses (`BlockingInEventLoopError`) from the first step on any configuration; the procedures say so with a typed `DoorReportUnavailableError` instead. Collecting them off the door's event loop is tracked in agent-shim#769.
 */
export const doorReportPorts: Pick<ControlApiDeps, "checkReport" | "doctorReport"> = {
  checkReport: () => {
    throw new DoorReportUnavailableError("check");
  },
  doctorReport: () => {
    throw new DoorReportUnavailableError("doctor");
  },
};
