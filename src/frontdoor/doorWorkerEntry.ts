import { parentPort, workerData } from "node:worker_threads";

import { checkReportToJson, collectCheckReport } from "../checkReport";
import { collectDoctorReport } from "../doctorReport";
import { buildLayoutPaths } from "../paths";
import { observeBlockingSteps } from "../processRole";
import { refreshCatalogueForReal } from "../realCatalogueRefresh";
import { doorWorkerInputSchemas, isDoorWorkerData, isIdentifier, type DoorWorkerMessage, type DoorWorkerTaskName, type DoorWorkerTasks } from "./doorWorkerProtocol";

/** Runs `task` on `input` against this worker's environment, which is a copy of the door's at the moment the worker started and whose module state (roles, caches, file wrappers) is its own. */
async function runTask(task: DoorWorkerTaskName, input: unknown, env: NodeJS.ProcessEnv): Promise<DoorWorkerTasks[DoorWorkerTaskName]["output"]> {
  switch (task) {
    case "check": {
      const request = doorWorkerInputSchemas.check.parse(input);
      return checkReportToJson(collectCheckReport({ paths: buildLayoutPaths(request.root), cwd: request.path, ...(request.identity === undefined ? {} : { identity: request.identity }), env }));
    }
    case "doctor": {
      const report = collectDoctorReport({ paths: buildLayoutPaths(doorWorkerInputSchemas.doctor.parse(input).root), env });
      return { ok: report.ok, findings: report.findings };
    }
    case "refresh-catalogue": {
      const request = doorWorkerInputSchemas["refresh-catalogue"].parse(input);
      await refreshCatalogueForReal(buildLayoutPaths(request.root), request.name, env, request.supervisorPid, request.generation);
      return undefined;
    }
    default:
      throw new Error(`unknown door worker task ${String(task satisfies never)}`);
  }
}

/** The failure a worker posts for an error: its class name and short code if they are identifiers, never its message. */
function failureOf(error: unknown): DoorWorkerMessage {
  const name = error instanceof Error && isIdentifier(error.name) ? error.name : "Error";
  const code: unknown = error instanceof Error && "code" in error ? error.code : undefined;
  return isIdentifier(code) ? { kind: "failed", name, code } : { kind: "failed", name };
}

/**
 * Runs the task a front door asked of this worker and posts its answer once. Called by the command line entry point when it is evaluated as a worker thread with door worker data; every blocking step the task takes beats the shared heartbeat the door's watchdog reads, and a task that throws answers `failed` with the error's class name and code, never its message or stack.
 */
export async function runDoorWorkerEntry(): Promise<void> {
  if (parentPort === null || !isDoorWorkerData(workerData)) {
    return;
  }
  const { task, input, heartbeat } = workerData.doorWorker;
  const beats = new Int32Array(heartbeat);
  observeBlockingSteps(() => {
    Atomics.add(beats, 0, 1);
  });
  const post = (message: DoorWorkerMessage): void => {
    parentPort?.postMessage(message);
  };
  try {
    post({ kind: "done", value: await runTask(task, input, process.env) });
  } catch (error) {
    post(failureOf(error));
  }
}
